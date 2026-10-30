import assert from "node:assert/strict";
import { test } from "node:test";
import { md, renderEntry } from "./render.ts";

test("model markdown cannot inject markup or make the browser fetch", () => {
	assert.equal(md("<script>alert(1)</script>").includes("<script"), false);
	assert.equal(md("hi <img src=x onerror=alert(1)>").includes("<img"), false);
	assert.equal(md("[x](javascript:alert(1))").includes("href"), false);
	assert.equal(md("![x](https://evil.example/?leak)").includes("<img"), false);
	assert.match(md("[ok](https://example.com)"), /<a href="https:\/\/example.com">ok<\/a>/);
});

test("a skill sent with /skill: is folded, and its text escaped", () => {
	const content = '<skill name="x<b>" location="/s">\n<script>\n</skill>\n\nhello';
	const entry = { id: 1, kind: "pi.user", model: [{ role: "user", content }] } as never;
	const html = renderEntry(entry);
	assert.match(html, /<summary>skill x&#60;b&#62;<\/summary>/);
	assert.match(html, /<div class="text">hello<\/div>/);
	assert.equal(html.includes("<script"), false);
});

test("code blocks are highlighted, unknown languages escaped", () => {
	assert.match(md("```js\nconst a = 1;\n```"), /<span class="hljs-keyword">const<\/span>/);
	assert.match(md("```nope\n<b>\n```"), /&#60;b&#62;/);
});
