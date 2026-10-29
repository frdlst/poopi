import assert from "node:assert/strict";
import { test } from "node:test";
import { md } from "./render.ts";

test("model markdown cannot inject markup or make the browser fetch", () => {
	assert.equal(md("<script>alert(1)</script>").includes("<script"), false);
	assert.equal(md("hi <img src=x onerror=alert(1)>").includes("<img"), false);
	assert.equal(md("[x](javascript:alert(1))").includes("href"), false);
	assert.equal(md("![x](https://evil.example/?leak)").includes("<img"), false);
	assert.match(md("[ok](https://example.com)"), /<a href="https:\/\/example.com">ok<\/a>/);
});

test("code blocks are highlighted, unknown languages escaped", () => {
	assert.match(md("```js\nconst a = 1;\n```"), /<span class="hljs-keyword">const<\/span>/);
	assert.match(md("```nope\n<b>\n```"), /&#60;b&#62;/);
});
