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
}

export interface PartyRepository {
  addArea(area: PartyArea): Promise<void>;
  listAreas(guildId: string): Promise<PartyArea[]>;
  findAreaByJoinChannel(joinChannelId: string): Promise<PartyArea | null>;
  findAreaByCategory(categoryId: string): Promise<PartyArea | null>;
  /** Also removes the area's party channel rows. False when the area was unknown. */
  deleteArea(joinChannelId: string): Promise<boolean>;
  /** Rejects when the member already owns a channel in the guild. */
  addChannel(channel: PartyChannel): Promise<void>;
  findChannel(channelId: string): Promise<PartyChannel | null>;
  findChannelByOwner(guildId: string, ownerId: string): Promise<PartyChannel | null>;
  listChannelsOfArea(joinChannelId: string): Promise<PartyChannel[]>;
  listChannels(): Promise<PartyChannel[]>;
  /** False when the row was already gone. */
  deleteChannel(channelId: string): Promise<boolean>;
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
      const deleted = await sql<PartyAreaRow[]>`
        DELETE FROM party_area WHERE join_channel_id = ${joinChannelId} RETURNING *
      `;
      return deleted.length > 0;
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
  };
}
