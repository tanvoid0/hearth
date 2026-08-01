import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, template, uniqueName } from "./workspace.ts";

test("slugify strips leading imperatives and connectors", () => {
  assert.equal(slugify("Build me a todo app with dark mode"), "todo-app-dark-mode");
  assert.equal(slugify("a landing page for my bakery"), "landing-page-bakery");
});

test("slugify survives punctuation, emoji and empty input", () => {
  assert.equal(slugify("  Make: a *Markdown* editor!! "), "markdown-editor");
  assert.equal(slugify("🚀"), "project");
  assert.equal(slugify("the a an"), "project");
});

test("slugify produces a usable folder name", () => {
  const name = slugify("build an extremely elaborate customer relationship management dashboard thing");
  assert.ok(name.length <= 40, name);
  assert.match(name, /^[a-z0-9][a-z0-9-]*$/);
});

test("uniqueName suffixes past collisions, case-insensitively", () => {
  assert.equal(uniqueName("todo-app", []), "todo-app");
  assert.equal(uniqueName("todo-app", ["todo-app"]), "todo-app-2");
  assert.equal(uniqueName("todo-app", ["Todo-App", "todo-app-2"]), "todo-app-3");
});

test("template is a runnable vite project with the name threaded through", () => {
  const files = template("todo-app");
  for (const required of ["package.json", "index.html", "vite.config.js", "src/main.jsx", "src/App.jsx"]) {
    assert.ok(files[required], `missing ${required}`);
  }
  assert.equal(JSON.parse(files["package.json"]).name, "todo-app");
  // index.html's script tag has to point at a file the template actually writes
  const entry = files["index.html"].match(/src="\/(.+?)"/)?.[1];
  assert.ok(entry && files[entry], `index.html entry ${entry} not in template`);
});
