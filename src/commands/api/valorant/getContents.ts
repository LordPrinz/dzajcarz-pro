import { ICommand } from "wokcommands";
import Api from "../../../libs/ValorantAPI";
import { Locale } from "wrapper-valorant-api/lib/types/LocalizedNamesDto";
import { Region } from "wrapper-valorant-api/lib/types/Region";
import { createWarningLog } from "../../../utilities/loger";
const locals = [
	"ar-AE",
	"de-DE",
	"en-GB",
	"en-US",
	"es-ES",
	"es-MX",
	"fr-FR",
	"id-ID",
	"it-IT",
	"ja-JP",
	"ko-KR",
	"pl-PL",
	"pt-BR",
	"ru-RU",
	"th-TH",
	"tr-TR",
	"vi-VN",
	"zh-CN",
	"zh-TW",
];

const regions = ["ap", "br", "esports", "eu", "kr", "latam", "na"];

const getContents = {
	category: "VALORANT API",
	description: "Get content filtered by locale.",
	slash: "both",
	minArgs: 1,
	expectedArgs: "<locale> <region>",
	testOnly: true,
	options: [
		{
			name: "locale",
			description: "The language of response",
			type: "STRING",
			required: true,
			choices: locals.map((locale) => ({
				name: locale,
				value: locale,
			})),
		},
		{
			name: "region",
			description: "The server you want to get data from.",
			type: "STRING",
			required: false,
			choices: regions.map((region) => ({
				name: region,
				value: region,
			})),
		},
	],

	callback: async ({ args }) => {
		if (!args) {
			return {
				custom: true,
				content: "You have to pass the locale!",
				ephemeral: true,
			};
		}

		const locale = args[0] as Locale;
		const region = args[1] as Region | undefined;

		const contents = await Api.getContents({
			locale,
			region,
		});

		return "OK";
	},
} as ICommand;

export default getContents;
