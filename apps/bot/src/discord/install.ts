import { PermissionFlagsBits } from "discord.js";

/** Same list as CONTRIBUTING's install settings: what the Developer Portal asks a server admin to grant. */
const GUILD_INSTALL_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.EmbedLinks |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.ManageRoles |
  PermissionFlagsBits.MoveMembers |
  PermissionFlagsBits.Connect |
  PermissionFlagsBits.Speak |
  PermissionFlagsBits.BanMembers |
  PermissionFlagsBits.KickMembers |
  PermissionFlagsBits.ModerateMembers |
  PermissionFlagsBits.AddReactions;

function authorizeUrl(params: Record<string, string>): string {
  return `https://discord.com/oauth2/authorize?${new URLSearchParams(params)}`;
}

/** The links behind /help's "Dodaj na serwer" and "Dodaj na konto" buttons. */
export function createInstallLinks(clientId: string): { guild: string; user: string } {
  return {
    guild: authorizeUrl({
      client_id: clientId,
      integration_type: "0",
      scope: "bot applications.commands",
      permissions: GUILD_INSTALL_PERMISSIONS.toString(),
    }),
    user: authorizeUrl({
      client_id: clientId,
      integration_type: "1",
      scope: "applications.commands",
    }),
  };
}
