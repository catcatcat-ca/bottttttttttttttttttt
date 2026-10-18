const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits,
  ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
  ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder, InteractionContextType,
} = require('discord.js');

const { TOKEN, CLIENT_ID, GUILD_ID, SUPPORT_ROLE_ID, TICKET_CATEGORY_ID, LOG_CHANNEL_ID, TRANSCRIPTS } = process.env;

const intents = [GatewayIntentBits.Guilds];
// Needed so transcripts contain message text. Also enable "Message Content Intent" in the Developer Portal.
if (TRANSCRIPTS === 'true') intents.push(GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessages);
const client = new Client({ intents });

const EPH = MessageFlags.Ephemeral;
const STYLES = { blue: ButtonStyle.Primary, green: ButtonStyle.Success, gray: ButtonStyle.Secondary, red: ButtonStyle.Danger };

/* ---------------- Commands ---------------- */
const commands = [
  new SlashCommandBuilder()
    .setName('ticketpanel')
    .setDescription('Post a ticket panel in this channel')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('title').setDescription('Panel title'))
    .addStringOption(o => o.setName('description').setDescription('Panel description (use \\n for new lines)'))
    .addStringOption(o => o.setName('color').setDescription('Embed color as hex, e.g. #ff0000'))
    .addStringOption(o => o.setName('button_label').setDescription('Text on the open button'))
    .addStringOption(o => o.setName('button_emoji').setDescription('Emoji on the open button (unicode or custom emoji)'))
    .addStringOption(o => o.setName('button_color').setDescription('Button color').addChoices(
      { name: 'Blue', value: 'blue' }, { name: 'Green', value: 'green' },
      { name: 'Gray', value: 'gray' }, { name: 'Red', value: 'red' }))
    .addStringOption(o => o.setName('image').setDescription('Large image URL for the panel'))
    .addStringOption(o => o.setName('thumbnail').setDescription('Small thumbnail image URL'))
    .addStringOption(o => o.setName('footer').setDescription('Footer text'))
    .addChannelOption(o => o.setName('category').setDescription('Category to create tickets in').addChannelTypes(ChannelType.GuildCategory))
    .addRoleOption(o => o.setName('support_role').setDescription('Role that can see and manage tickets from this panel'))
    .addChannelOption(o => o.setName('log_channel').setDescription('Channel for ticket logs/transcripts').addChannelTypes(ChannelType.GuildText))
    .addBooleanOption(o => o.setName('ask_reason').setDescription('Ask the user for a reason before opening'))
    .addIntegerOption(o => o.setName('max_tickets').setDescription('Max open tickets per user (default 1)').setMinValue(1).setMaxValue(10)),

  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Manage the current ticket')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand(s => s.setName('add').setDescription('Add a user to this ticket')
      .addUserOption(o => o.setName('user').setDescription('User to add').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove a user from this ticket')
      .addUserOption(o => o.setName('user').setDescription('User to remove').setRequired(true)))
    .addSubcommand(s => s.setName('rename').setDescription('Rename this ticket')
      .addStringOption(o => o.setName('name').setDescription('New channel name').setRequired(true)))
    .addSubcommand(s => s.setName('close').setDescription('Close this ticket')),
].map(c => c.toJSON());

client.once('clientReady', async () => {
  const rest = new REST().setToken(TOKEN);
  await rest.put(
    GUILD_ID ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID) : Routes.applicationCommands(CLIENT_ID),
    { body: commands },
  );
  console.log(`Logged in as ${client.user.tag}, commands registered.`);
});

/* ---------------- Helpers ---------------- */
// Panel settings live in the button's customId, so they survive restarts with no database.
// Format: ticket_open:<category>:<role>:<log>:<max>:<askReason>   ("0" = not set)
const buildOpenId = (c) => `ticket_open:${c.category || 0}:${c.role || 0}:${c.log || 0}:${c.max || 1}:${c.reason ? 1 : 0}`;
function parseCfg(customId) {
  const p = customId.split(':');
  const val = (x) => (x && x !== '0' ? x : null);
  return {
    category: val(p[1]) || TICKET_CATEGORY_ID || null,
    role: val(p[2]) || SUPPORT_ROLE_ID || null,
    log: val(p[3]) || LOG_CHANNEL_ID || null,
    max: Number(p[4]) || 1,
    reason: p[5] === '1',
  };
}
// Ticket channel topic: ticket:<ownerId>:<roleId>:<logChannelId>
function ticketInfo(channel) {
  if (!channel?.topic?.startsWith('ticket:')) return null;
  const p = channel.topic.split(':');
  const val = (x) => (x && x !== '0' ? x : null);
  return { owner: p[1], role: val(p[2]) || SUPPORT_ROLE_ID || null, log: val(p[3]) || LOG_CHANNEL_ID || null };
}
const isStaff = (member, role) =>
  (role && member.roles.cache.has(role)) || member.permissions.has(PermissionFlagsBits.ManageChannels);

async function sendLog(guild, logId, payload) {
  if (!logId) return;
  const ch = await guild.channels.fetch(logId).catch(() => null);
  if (ch) await ch.send(payload).catch(console.error);
}

async function buildTranscript(channel) {
  const all = [];
  let before;
  for (let n = 0; n < 10; n++) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || !batch.size) break;
    all.push(...batch.values());
    before = batch.last().id;
  }
  all.reverse();
  return all.map(m => {
    const files = m.attachments.size ? ' ' + [...m.attachments.values()].map(a => a.url).join(' ') : '';
    return `[${m.createdAt.toISOString()}] ${m.author.tag}: ${m.content}${files}`;
  }).join('\n') || 'No messages.';
}

const ticketButtons = (claimed = false) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('ticket_claim').setLabel(claimed ? 'Claimed' : 'Claim').setEmoji('🙋').setStyle(ButtonStyle.Success).setDisabled(claimed),
  new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
);

async function createTicket(i, cfg, reason) {
  await i.deferReply({ flags: EPH });
  const open = i.guild.channels.cache.filter(c => c.topic?.startsWith(`ticket:${i.user.id}:`) || c.topic === `ticket:${i.user.id}`);
  if (open.size >= cfg.max) {
    return i.editReply(`You already have ${open.size >= 2 ? 'the maximum number of tickets' : 'a ticket'} open: ${open.first()}`);
  }
  const name = (`ticket-${i.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90)) || 'ticket-user';
  const overwrites = [
    { id: i.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
  ];
  if (cfg.role) overwrites.push({ id: cfg.role, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] });

  const channel = await i.guild.channels.create({
    name, type: ChannelType.GuildText, parent: cfg.category,
    topic: `ticket:${i.user.id}:${cfg.role || 0}:${cfg.log || 0}`,
    permissionOverwrites: overwrites,
  });

  const embed = new EmbedBuilder()
    .setTitle('🎫 Ticket opened')
    .setDescription('Thanks for reaching out! Describe your issue and staff will be with you shortly.')
    .addFields({ name: 'Opened by', value: `${i.user}`, inline: true })
    .setColor(0x57f287).setTimestamp();
  if (reason) embed.addFields({ name: 'Reason', value: reason.slice(0, 1000) });

  await channel.send({
    content: `${i.user}${cfg.role ? ` <@&${cfg.role}>` : ''}`,
    embeds: [embed], components: [ticketButtons()],
  });
  await sendLog(i.guild, cfg.log, { embeds: [new EmbedBuilder().setTitle('Ticket opened').setColor(0x57f287)
    .setDescription(`${channel} opened by ${i.user}${reason ? `\n**Reason:** ${reason.slice(0, 500)}` : ''}`).setTimestamp()] });
  return i.editReply(`Ticket created: ${channel}`);
}

async function closeTicket(i, info) {
  await i.reply('🔒 Closing this ticket in 5 seconds...');
  const channel = i.channel;
  const payload = { embeds: [new EmbedBuilder().setTitle('Ticket closed').setColor(0xed4245)
    .setDescription(`**${channel.name}** (owner <@${info.owner}>) closed by ${i.user}`).setTimestamp()] };
  if (TRANSCRIPTS === 'true') {
    const text = await buildTranscript(channel);
    payload.files = [new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: `${channel.name}-transcript.txt` })];
  }
  await sendLog(i.guild, info.log, payload);
  setTimeout(() => channel.delete().catch(console.error), 5000);
}

/* ---------------- Interactions ---------------- */
client.on('interactionCreate', async (i) => {
  try {
    // /ticketpanel
    if (i.isChatInputCommand() && i.commandName === 'ticketpanel') {
      const o = i.options;
      const colorRaw = o.getString('color');
      if (colorRaw && !/^#?[0-9a-f]{6}$/i.test(colorRaw)) {
        return i.reply({ content: 'Color must be a hex code like `#ff0000`.', flags: EPH });
      }
      const embed = new EmbedBuilder()
        .setTitle(o.getString('title') ?? '🎫 Support Tickets')
        .setDescription((o.getString('description') ?? 'Need help? Click the button below to open a ticket.').replace(/\\n/g, '\n'))
        .setColor(colorRaw ? parseInt(colorRaw.replace('#', ''), 16) : 0x5865f2);
      if (o.getString('image')) embed.setImage(o.getString('image'));
      if (o.getString('thumbnail')) embed.setThumbnail(o.getString('thumbnail'));
      if (o.getString('footer')) embed.setFooter({ text: o.getString('footer') });

      const button = new ButtonBuilder()
        .setCustomId(buildOpenId({
          category: o.getChannel('category')?.id, role: o.getRole('support_role')?.id,
          log: o.getChannel('log_channel')?.id, max: o.getInteger('max_tickets'), reason: o.getBoolean('ask_reason'),
        }))
        .setLabel(o.getString('button_label') ?? 'Open Ticket')
        .setStyle(STYLES[o.getString('button_color') ?? 'blue']);
      button.setEmoji(o.getString('button_emoji') ?? '🎫');

      try {
        await i.channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] });
      } catch (e) {
        console.error(e);
        return i.reply({ content: 'Could not post the panel. Check your emoji and image URLs are valid, and that I can send messages here.', flags: EPH });
      }
      return i.reply({ content: 'Panel posted!', flags: EPH });
    }

    // /ticket subcommands
    if (i.isChatInputCommand() && i.commandName === 'ticket') {
      const info = ticketInfo(i.channel);
      if (!info) return i.reply({ content: 'Use this inside a ticket channel.', flags: EPH });
      const sub = i.options.getSubcommand();
      if (sub === 'close') {
        if (i.user.id !== info.owner && !isStaff(i.member, info.role)) return i.reply({ content: "You can't close this ticket.", flags: EPH });
        return closeTicket(i, info);
      }
      if (!isStaff(i.member, info.role)) return i.reply({ content: 'Only staff can do that.', flags: EPH });
      if (sub === 'add') {
        const user = i.options.getUser('user');
        await i.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
        return i.reply(`${user} was added to the ticket.`);
      }
      if (sub === 'remove') {
        const user = i.options.getUser('user');
        if (user.id === info.owner) return i.reply({ content: "You can't remove the ticket owner.", flags: EPH });
        await i.channel.permissionOverwrites.delete(user.id);
        return i.reply(`${user} was removed from the ticket.`);
      }
      if (sub === 'rename') {
        await i.channel.setName(i.options.getString('name').slice(0, 100));
        return i.reply({ content: 'Ticket renamed.', flags: EPH });
      }
    }

    // Open button
    if (i.isButton() && i.customId.startsWith('ticket_open')) {
      const cfg = parseCfg(i.customId);
      if (cfg.reason) {
        const modal = new ModalBuilder()
          .setCustomId(`ticket_modal${i.customId.slice('ticket_open'.length)}`)
          .setTitle('Open a ticket')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('reason').setLabel('What do you need help with?')
              .setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true)));
        return i.showModal(modal);
      }
      return createTicket(i, cfg, null);
    }

    // Reason modal submitted
    if (i.isModalSubmit() && i.customId.startsWith('ticket_modal')) {
      const cfg = parseCfg(`ticket_open${i.customId.slice('ticket_modal'.length)}`);
      return createTicket(i, cfg, i.fields.getTextInputValue('reason'));
    }

    // Claim
    if (i.isButton() && i.customId === 'ticket_claim') {
      const info = ticketInfo(i.channel);
      if (!info || !isStaff(i.member, info.role)) return i.reply({ content: 'Only staff can claim tickets.', flags: EPH });
      const embed = EmbedBuilder.from(i.message.embeds[0]).addFields({ name: 'Claimed by', value: `${i.user}`, inline: true });
      await i.update({ embeds: [embed], components: [ticketButtons(true)] });
      return i.channel.send(`🙋 ${i.user} will be handling this ticket.`);
    }

    // Close
    if (i.isButton() && i.customId === 'ticket_close') {
      const info = ticketInfo(i.channel);
      if (!info) return i.reply({ content: 'This is not a ticket channel.', flags: EPH });
      if (i.user.id !== info.owner && !isStaff(i.member, info.role)) return i.reply({ content: "You can't close this ticket.", flags: EPH });
      return closeTicket(i, info);
    }
  } catch (err) {
    console.error(err);
    const msg = { content: 'Something went wrong.', flags: EPH };
    if (i.deferred) i.editReply(msg.content).catch(() => {});
    else if (!i.replied) i.reply(msg).catch(() => {});
  }
});

client.login(TOKEN);
