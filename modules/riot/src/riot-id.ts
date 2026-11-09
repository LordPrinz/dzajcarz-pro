import { UserError } from "@dzajcarz/core";
import type { RiotId } from "./ports.ts";

export const RIOT_ID_HELP = "Podaj Riot ID jako `Nazwa#TAG`.";

const NAME_LENGTH = { min: 3, max: 16 };
const TAG = /^[\p{L}\p{N}]{3,5}$/u;

/** Splits `Name#TAG` on the last `#`; Riot names may contain spaces and non-Latin letters, but no `#`. */
export function parseRiotId(input: string): RiotId {
  const text = input.trim();
  const hash = text.lastIndexOf("#");
  if (hash < 0) throw new UserError(RIOT_ID_HELP);
  const gameName = text.slice(0, hash).trim();
  const tagLine = text.slice(hash + 1).trim();
  const length = [...gameName].length;
  if (
    gameName.includes("#") ||
    length < NAME_LENGTH.min ||
    length > NAME_LENGTH.max ||
    !TAG.test(tagLine)
  ) {
    throw new UserError(RIOT_ID_HELP);
  }
  return { gameName, tagLine };
}
