import { z } from "zod";

export const Snowflake = z.string().regex(/^\d{17,20}$/, "expected a Discord id (17-20 digits)");
