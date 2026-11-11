/// <reference path="./sql.d.ts" />
// Imported as text so `bun build --compile` embeds them: the compiled bot has no migrations directory to
// scan. migrations.test.ts fails when a file in migrations/ is missing here or differs from its file.
import m0001 from "../migrations/0001_init.sql" with { type: "text" };
import m0002 from "../migrations/0002_module_toggles.sql" with { type: "text" };
import m0003 from "../migrations/0003_welcome.sql" with { type: "text" };
import m0004 from "../migrations/0004_party.sql" with { type: "text" };
import m0005 from "../migrations/0005_party_area_form.sql" with { type: "text" };
import m0006 from "../migrations/0006_party_panel.sql" with { type: "text" };
import m0007 from "../migrations/0007_scheduled_songs.sql" with { type: "text" };
import m0008 from "../migrations/0008_moderation.sql" with { type: "text" };
import m0009 from "../migrations/0009_dzajco.sql" with { type: "text" };
import m0010 from "../migrations/0010_scheduled_messages.sql" with { type: "text" };
import m0011 from "../migrations/0011_guild_time_zone.sql" with { type: "text" };
import m0012 from "../migrations/0012_dzajco_dm.sql" with { type: "text" };
import m0013 from "../migrations/0013_scheduled_message_last_sent.sql" with { type: "text" };

export interface Migration {
  /** File name, e.g. `0001_init.sql`: the key in `schema_migrations`. */
  name: string;
  /** The SQL exactly as in the file, since its checksum is compared with the applied one. */
  content: string;
}

/** Every migration, in the order it is applied. */
export const MIGRATIONS: readonly Migration[] = [
  { name: "0001_init.sql", content: m0001 },
  { name: "0002_module_toggles.sql", content: m0002 },
  { name: "0003_welcome.sql", content: m0003 },
  { name: "0004_party.sql", content: m0004 },
  { name: "0005_party_area_form.sql", content: m0005 },
  { name: "0006_party_panel.sql", content: m0006 },
  { name: "0007_scheduled_songs.sql", content: m0007 },
  { name: "0008_moderation.sql", content: m0008 },
  { name: "0009_dzajco.sql", content: m0009 },
  { name: "0010_scheduled_messages.sql", content: m0010 },
  { name: "0011_guild_time_zone.sql", content: m0011 },
  { name: "0012_dzajco_dm.sql", content: m0012 },
  { name: "0013_scheduled_message_last_sent.sql", content: m0013 },
];
