import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { formatTimestamp, httpsUrl, Markdown, parseBlocks, parseInline } from "./markdown.tsx";
import { emptyResolved, type Resolved } from "./reading-api.ts";

const USER = "300000000000000003";
const ROLE = "400000000000000004";
const CHANNEL = "200000000000000002";
const EMOJI = "600000000000000006";

const render = (text: string, resolved: Resolved = emptyResolved()) =>
  renderToStaticMarkup(<Markdown text={text} resolved={resolved} />);

describe("message text is never HTML", () => {
  test("HTML and a script render as text", () => {
    const html = render('<script>alert("x")</script><img src=x onerror=alert(1)><b>gruby</b>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  test("HTML inside markdown stays text too", () => {
    const html = render("**<i>a</i>** `<b>` ```\n<script>x</script>\n```");
    expect(html).toContain("<strong>&lt;i&gt;a&lt;/i&gt;</strong>");
    expect(html).toContain("<code>&lt;b&gt;</code>");
    expect(html).not.toContain("<script");
  });

  test.each([
    ["a javascript: masked link", "[kliknij](javascript:alert(1))"],
    ["a data: masked link", "[kliknij](data:text/html,<script>alert(1)</script>)"],
    ["a vbscript: masked link", "[kliknij](vbscript:msgbox)"],
    ["an http masked link", "[kliknij](http://example.com)"],
    ["an http autolink", "<http://example.com>"],
    ["a plain http link", "http://example.com"],
    ["a javascript: autolink", "<javascript:alert(1)>"],
  ])("%s is not a link", (_label, text) => {
    const html = render(text);
    expect(html).not.toContain("<a");
    expect(html).not.toContain("href");
  });

  test("an https link opens in a new tab without referrer or opener", () => {
    expect(render("[strona](https://example.com/a?b=1)")).toBe(
      '<div class="md"><p class="md-p"><a href="https://example.com/a?b=1" target="_blank" ' +
        'rel="noopener noreferrer nofollow">strona</a></p></div>',
    );
    expect(render("zobacz https://example.com/x.")).toContain(
      '<a href="https://example.com/x" target="_blank"',
    );
  });

  test("a link inside a link label is not a second link", () => {
    const html = render("[https://a.example](https://b.example)");
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('href="https://b.example/"');
  });

  test("a masked link with an attribute-breaking URL stays a plain href", () => {
    const html = render('[x](https://example.com/"onmouseover=alert(1))');
    expect(html).not.toContain(" onmouseover=");
  });

  test("deep nesting does not throw and stops being parsed", () => {
    const text = `${"**".repeat(200)}x${"**".repeat(200)}`;
    expect(() => render(text)).not.toThrow();
    expect(() => render("||".repeat(5000))).not.toThrow();
  });
});

describe("inline markdown", () => {
  test("emphasis, underline, strike, code and spoiler", () => {
    const html = render("**b** *i* _i2_ __u__ ~~s~~ `c` ||sekret|| ***bi***");
    expect(html).toContain("<strong>b</strong>");
    expect(html).toContain("<em>i</em>");
    expect(html).toContain("<em>i2</em>");
    expect(html).toContain("<u>u</u>");
    expect(html).toContain("<s>s</s>");
    expect(html).toContain("<code>c</code>");
    expect(html).toContain('class="spoiler"');
    expect(html).toContain("<strong><em>bi</em></strong>");
  });

  test("snake_case words are not italic, escapes are literal", () => {
    expect(render("snake_case_name")).not.toContain("<em>");
    expect(render("\\*nie\\*")).toContain("*nie*");
  });

  test("mentions resolve to names, unknown ones say so", () => {
    const resolved: Resolved = {
      users: { [USER]: "Ola" },
      roles: { [ROLE]: { name: "Admini", color: 0xff0000 } },
      channels: { [CHANNEL]: "ogólny" },
    };
    const html = render(
      `<@${USER}> <@!${USER}> <@&${ROLE}> <#${CHANNEL}> <@${CHANNEL}> @everyone`,
      resolved,
    );
    expect(html.match(/@Ola/g)).toHaveLength(2);
    expect(html).toContain("@Admini");
    expect(html).toContain("color:#ff0000");
    expect(html).toContain("#ogólny");
    expect(html).toContain("@nieznany-użytkownik");
    expect(html).toContain('<span class="mention">@everyone</span>');
  });

  test("custom emoji load from Discord's CDN, animated as gif", () => {
    const html = render(`<:kek:${EMOJI}> <a:dance:${EMOJI}>`);
    expect(html).toContain(`src="https://cdn.discordapp.com/emojis/${EMOJI}.webp?size=48"`);
    expect(html).toContain(`src="https://cdn.discordapp.com/emojis/${EMOJI}.gif?size=48"`);
    expect(html).toContain('alt=":kek:"');
  });

  test("timestamps render as <time>", () => {
    const html = render("<t:1762000000:D> <t:99999999999999:R>");
    expect(html).toContain('<time dateTime="2025-11-01T12:26:40.000Z"');
    expect(html).toContain("2025");
    expect(html).toContain("&lt;t:99999999999999:R&gt;");
  });

  test("newlines become line breaks", () => {
    expect(parseInline("a\nb")).toEqual([
      { type: "text", text: "a" },
      { type: "br" },
      { type: "text", text: "b" },
    ]);
  });
});

describe("blocks", () => {
  test("code blocks keep their text and language", () => {
    expect(parseBlocks("```ts\nconst a = 1;\n```\npo")).toEqual([
      { type: "codeblock", lang: "ts", text: "const a = 1;" },
      { type: "paragraph", children: [{ type: "text", text: "po" }] },
    ]);
    expect(render("```\n**nie gruby**\n```")).toContain("<code>**nie gruby**</code>");
  });

  test("quotes, headings, subtext and lists", () => {
    const html = render("# Tytuł\n> cytat\n> dalej\n-# drobny\n- a\n- b\n1. x\n2. y\nkoniec");
    expect(html).toContain('<h3 class="md-heading">Tytuł</h3>');
    expect(html).toContain('<blockquote class="md-quote"><p class="md-p">cytat<br/>dalej</p>');
    expect(html).toContain('<p class="md-subtext">drobny</p>');
    expect(html).toContain("<ul><li>a</li><li>b</li></ul>");
    expect(html).toContain('<ol start="1"><li>x</li><li>y</li></ol>');
    expect(html).toContain('<p class="md-p">koniec</p>');
  });

  test(">>> quotes the rest of the message, quotes do not nest", () => {
    expect(parseBlocks(">>> a\n> b")).toEqual([
      {
        type: "quote",
        children: [
          {
            type: "paragraph",
            children: [{ type: "text", text: "a" }, { type: "br" }, { type: "text", text: "> b" }],
          },
        ],
      },
    ]);
  });
});

describe("httpsUrl", () => {
  test("only https", () => {
    expect(httpsUrl("https://a.example/x")).toBe("https://a.example/x");
    expect(httpsUrl("HTTPS://A.example")).toBe("https://a.example/");
    expect(httpsUrl("http://a.example")).toBeNull();
    expect(httpsUrl("javascript:alert(1)")).toBeNull();
    expect(httpsUrl(" javascript:alert(1)")).toBeNull();
    expect(httpsUrl("//a.example")).toBeNull();
  });
});

describe("formatTimestamp", () => {
  test("relative times read in Polish", () => {
    const now = 1_000_000_000_000;
    expect(formatTimestamp(now / 1000 - 120, "R", now)).toBe("2 minuty temu");
    expect(formatTimestamp(now / 1000 + 3 * 86400, "R", now)).toBe("za 3 dni");
  });
});

describe("hostile input stays fast", () => {
  const timed = (run: () => unknown) => {
    const start = performance.now();
    run();
    return performance.now() - start;
  };

  test("a message of backticks, and of fences", () => {
    expect(timed(() => parseInline("`".repeat(4000)))).toBeLessThan(50);
    expect(timed(() => parseBlocks("```".repeat(1333)))).toBeLessThan(50);
    expect(timed(() => parseBlocks("``\n".repeat(1333)))).toBeLessThan(50);
    expect(timed(() => parseInline("`a``".repeat(1000)))).toBeLessThan(50);
  });

  test.each([
    ["stars", "*a".repeat(2000)],
    ["double stars", "**a".repeat(1333)],
    ["underscores", "_a".repeat(2000)],
    ["double underscores", "__a".repeat(1333)],
    ["nested openers", `${"**__~~||*".repeat(8)}a`.padEnd(4000, "b")],
    ["tildes", "~~a".repeat(1333)],
    ["pipes", "||a".repeat(1333)],
    ["unclosed links", "[a](https://x".repeat(300)],
    ["link labels", "[".repeat(4000)],
    ["angle brackets", "<@".repeat(2000)],
    ["timestamps", "<t:1".repeat(1000)],
    ["plain urls", "http://.".repeat(500)],
    ["https runs", "https://a".repeat(444)],
    ["mixed", "*_~|`".repeat(800)],
    ["stars only", "**".repeat(2000)],
    ["quotes", "> **a\n".repeat(600)],
    ["lists", "- *a\n".repeat(800)],
    ["escapes", "\\*".repeat(2000)],
  ])("%s", (_label, text) => {
    const input = text.slice(0, 4000);
    expect(timed(() => parseBlocks(input))).toBeLessThan(50);
  });
});

describe("links in context", () => {
  test("a URL glued to a word is not a link", () => {
    expect(render("xhttps://example.com")).not.toContain("<a");
    expect(render("(https://example.com)")).toContain('href="https://example.com/"');
  });

  test("a hidden spoiler is a keyboard button whose link cannot be reached", () => {
    const html = render("||[tajne](https://example.com)||");
    expect(html).toMatch(/<span class="spoiler" role="button" tabindex="0"[^>]*><span inert="">/);
    expect(html).toContain('href="https://example.com/"');
  });
});
