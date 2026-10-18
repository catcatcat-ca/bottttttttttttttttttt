const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits, ChannelType, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');

const { TOKEN, CLIENT_ID, GUILD_ID, SUPPORT_ROLE_ID, TICKET_CATEGORY_ID } = process.env;
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder()
    .setName('ticketpanel')
    .setDescription('Post a ticket panel in this channel')
    .addStringOption(o => o.setName('title').setDescription('Panel title'))
    .addStringOption(o => o.setName('description').setDescription('Panel description'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map(c => c.toJSON());

client.once('clientReady', async () => {
  const rest = new REST().setToken(TOKEN);
  await rest.put(
    GUILD_ID
      ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
      : Routes.applicationCommands(CLIENT_ID),
    { body: commands },
  );
  console.log(`Logged in as ${client.user.tag}, commands registered.`);
});

client.on('interactionCreate', async (i) => {
  try {
    // /ticketpanel
    if (i.isChatInputCommand() && i.commandName === 'ticketpanel') {
      const embed = new EmbedBuilder()
        .setTitle(i.options.getString('title') ?? '🎫 Support Tickets')
        .setDescription(i.options.getString('description') ?? 'Need help? Click the button below to open a ticket.')
        .setColor(0x5865f2);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_open').setLabel('Open Ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary),
      );
      await i.channel.send({ embeds: [embed], components: [row] });
      return i.reply({ content: 'Panel posted!', flags: MessageFlags.Ephemeral });
    }

    // Open ticket
    if (i.isButton() && i.customId === 'ticket_open') {
      const name = `ticket-${i.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90);
      const existing = i.guild.channels.cache.find(c => c.topic === `ticket:${i.user.id}`);
      if (existing) {
        return i.reply({ content: `You already have a ticket: ${existing}`, flags: MessageFlags.Ephemeral });
      }
      const overwrites = [
        { id: i.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
      ];
      if (SUPPORT_ROLE_ID) {
        overwrites.push({ id: SUPPORT_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
      }
      const channel = await i.guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: TICKET_CATEGORY_ID || null,
        topic: `ticket:${i.user.id}`,
        permissionOverwrites: overwrites,
      });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
      );
      await channel.send({
        content: `${i.user}${SUPPORT_ROLE_ID ? ` <@&${SUPPORT_ROLE_ID}>` : ''}`,
        embeds: [new EmbedBuilder().setDescription('Thanks for opening a ticket! Describe your issue and staff will be with you shortly.').setColor(0x57f287)],
        components: [row],
      });
      return i.reply({ content: `Ticket created: ${channel}`, flags: MessageFlags.Ephemeral });
    }

    // Close ticket
    if (i.isButton() && i.customId === 'ticket_close') {
      const ownerId = i.channel.topic?.replace('ticket:', '');
      const isStaff = SUPPORT_ROLE_ID && i.member.roles.cache.has(SUPPORT_ROLE_ID);
      const canManage = i.member.permissions.has(PermissionFlagsBits.ManageChannels);
      if (i.user.id !== ownerId && !isStaff && !canManage) {
        return i.reply({ content: "You can't close this ticket.", flags: MessageFlags.Ephemeral });
      }
      await i.reply('🔒 Closing this ticket in 5 seconds...');
      setTimeout(() => i.channel.delete().catch(console.error), 5000);
    }
  } catch (err) {
    console.error(err);
    if (!i.replied && !i.deferred) i.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.login(TOKEN);
