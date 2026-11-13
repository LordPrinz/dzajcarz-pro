/** Discord allows two renames per channel per ten minutes; counting here avoids a rate-limit stall. */
export const MAX_RENAMES = 2;

export const SPECIAL_OWNER_PER_MINUTE = 1;

export const SPECIAL_OWNER_PER_HOUR = 5;

/** Most people one special invite can go to. */
export const SPECIAL_MAX_MEMBERS = 10;

/** Discord's limit for channel and category names. */
export const MAX_NAME_LENGTH = 100;

/** Longest template: leaves room for a display name before the 100 character cut. */
export const MAX_TEMPLATE_LENGTH = 90;

export const USER_PLACEHOLDER = "{user}";

/** Zero-width and other invisible format characters (\\p{Cf}); they would make a name look empty. */
export const INVISIBLE = /\p{Cf}/gu;

/** Discord's user limit for a voice channel is 99; 0 removes it. */
export const MAX_USER_LIMIT = 99;
