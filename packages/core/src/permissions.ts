/** Discord permission bits (PermissionFlagsBits) that more than one module checks; modules do not import discord.js at runtime. */
export const ADMINISTRATOR = 1n << 3n;
export const MANAGE_GUILD = 1n << 5n;

/** Whether the member holds Administrator, which Discord treats as every permission. */
export function isAdministrator(granted: bigint | null | undefined): boolean {
  return ((granted ?? 0n) & ADMINISTRATOR) === ADMINISTRATOR;
}

/** Whether `granted` holds every bit of `required`, or Administrator. */
export function hasPermissions(granted: bigint | null | undefined, required: bigint): boolean {
  return isAdministrator(granted) || ((granted ?? 0n) & required) === required;
}
