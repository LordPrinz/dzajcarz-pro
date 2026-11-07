import type { SQL } from "bun";
import type { PartyAreaRow, PartyChannelRow } from "./types.ts";

export interface PartyArea {
  guildId: string;
  categoryId: string;
  joinChannelId: string;
}

export interface PartyChannel {
  channelId: string;
  guildId: string;
  ownerId: string;
  /** The join channel of the area this channel was created for. */
  joinChannelId: string;
  createdAt: Date;
}

export interface PartyRepository {
  addArea(area: PartyArea): Promise<void>;
  listAreas(guildId: string): Promise<PartyArea[]>;
  /** Every guild's areas, for startup reconciliation. */
  listAllAreas(): Promise<PartyArea[]>;
  findAreaByJoinChannel(joinChannelId: string): Promise<PartyArea | null>;
  findAreaByCategory(categoryId: string): Promise<PartyArea | null>;
  /** Removes the area and its party channel rows in one transaction and returns those rows; null when the area was unknown. */
  deleteArea(joinChannelId: string): Promise<PartyChannel[] | null>;
  /** Rejects when the member already owns a channel in the guild. */
  addChannel(channel: Omit<PartyChannel, "createdAt">): Promise<void>;
  findChannel(channelId: string): Promise<PartyChannel | null>;
  findChannelByOwner(guildId: string, ownerId: string): Promise<PartyChannel | null>;
  listChannelsOfArea(joinChannelId: string): Promise<PartyChannel[]>;
  listChannels(): Promise<PartyChannel[]>;
  /** False when the row was already gone. */
  deleteChannel(channelId: string): Promise<boolean>;
  /**
   * Makes `newOwnerId` the owner while `expectedOwnerId` still is. False when the owner changed, the channel is
   * gone or the member already owns another channel in the guild.
   */
  transferOwner(channelId: string, expectedOwnerId: string, newOwnerId: string): Promise<boolean>;
}

const toArea = (row: PartyAreaRow): PartyArea => ({
  guildId: row.guild_id,
  categoryId: row.category_id,
  joinChannelId: row.join_channel_id,
});

const toChannel = (row: PartyChannelRow): PartyChannel => ({
  channelId: row.channel_id,
  guildId: row.guild_id,
  ownerId: row.owner_id,
  joinChannelId: row.area_join_channel_id,
  createdAt: row.created_at,
});

export function createPartyRepository(sql: SQL): PartyRepository {
  return {
    async addArea({ guildId, categoryId, joinChannelId }) {
      await sql`
        INSERT INTO party_area (join_channel_id, guild_id, category_id)
        VALUES (${joinChannelId}, ${guildId}, ${categoryId})
      `;
    },

    async listAreas(guildId) {
      const rows = await sql<PartyAreaRow[]>`
        SELECT * FROM party_area WHERE guild_id = ${guildId} ORDER BY created_at, join_channel_id
      `;
      return rows.map(toArea);
    },

    async listAllAreas() {
      const rows = await sql<PartyAreaRow[]>`SELECT * FROM party_area ORDER BY created_at`;
      return rows.map(toArea);
    },

    async findAreaByJoinChannel(joinChannelId) {
      const [row] = await sql<PartyAreaRow[]>`
        SELECT * FROM party_area WHERE join_channel_id = ${joinChannelId}
      `;
      return row ? toArea(row) : null;
    },

    async findAreaByCategory(categoryId) {
      const [row] = await sql<PartyAreaRow[]>`
        SELECT * FROM party_area WHERE category_id = ${categoryId}
      `;
      return row ? toArea(row) : null;
    },

    async deleteArea(joinChannelId) {
      return sql.begin(async (tx) => {
        const channels = await tx<PartyChannelRow[]>`
          DELETE FROM party_channel WHERE area_join_channel_id = ${joinChannelId} RETURNING *
        `;
        const areas = await tx<PartyAreaRow[]>`
          DELETE FROM party_area WHERE join_channel_id = ${joinChannelId} RETURNING *
        `;
        return areas.length > 0 ? channels.map(toChannel) : null;
      });
    },

    async addChannel({ channelId, guildId, ownerId, joinChannelId }) {
      await sql`
        INSERT INTO party_channel (channel_id, guild_id, owner_id, area_join_channel_id)
        VALUES (${channelId}, ${guildId}, ${ownerId}, ${joinChannelId})
      `;
    },

    async findChannel(channelId) {
      const [row] = await sql<PartyChannelRow[]>`
        SELECT * FROM party_channel WHERE channel_id = ${channelId}
      `;
      return row ? toChannel(row) : null;
    },

    async findChannelByOwner(guildId, ownerId) {
      const [row] = await sql<PartyChannelRow[]>`
        SELECT * FROM party_channel WHERE guild_id = ${guildId} AND owner_id = ${ownerId}
      `;
      return row ? toChannel(row) : null;
    },

    async listChannelsOfArea(joinChannelId) {
      const rows = await sql<PartyChannelRow[]>`
        SELECT * FROM party_channel WHERE area_join_channel_id = ${joinChannelId} ORDER BY created_at
      `;
      return rows.map(toChannel);
    },

    async listChannels() {
      const rows = await sql<PartyChannelRow[]>`SELECT * FROM party_channel ORDER BY created_at`;
      return rows.map(toChannel);
    },

    async deleteChannel(channelId) {
      const deleted = await sql<PartyChannelRow[]>`
        DELETE FROM party_channel WHERE channel_id = ${channelId} RETURNING *
      `;
      return deleted.length > 0;
    },

    async transferOwner(channelId, expectedOwnerId, newOwnerId) {
      const updated = await sql<PartyChannelRow[]>`
        UPDATE party_channel SET owner_id = ${newOwnerId}
        WHERE channel_id = ${channelId}
          AND owner_id = ${expectedOwnerId}
          AND NOT EXISTS (
            SELECT 1 FROM party_channel other
            WHERE other.guild_id = party_channel.guild_id AND other.owner_id = ${newOwnerId}
          )
        RETURNING *
      `;
      return updated.length > 0;
    },
  };
}
