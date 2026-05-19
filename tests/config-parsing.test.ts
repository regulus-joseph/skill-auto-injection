import { describe, it, expect } from "vitest";
import { parseSkillMarkdown } from "../src/utils.ts";

describe("parseSkillMarkdown", () => {
  it("extracts name and description from SKILL.md", () => {
    const content = `---
name: git-tool
description: A comprehensive Git tool for version control operations including commit, branch, merge, and stash management.
---

# Git Tool

## Usage`;
    const result = parseSkillMarkdown(content, "fallback");
    expect(result.name).toBe("git-tool");
    expect(result.description).toContain("Git tool");
  });

  it("uses fallback name when name not found", () => {
    const result = parseSkillMarkdown("no name here", "my-skill");
    expect(result.name).toBe("my-skill");
  });

  it("extracts multi-line description", () => {
    const content = `name: test
description: This is a test skill.
  It handles multiple scenarios.
  And various use cases.`;
    const result = parseSkillMarkdown(content, "fallback");
    expect(result.name).toBe("test");
    expect(result.description).toContain("test skill");
    expect(result.description).toContain("multiple scenarios");
  });

  it("ignores lines starting with # or -", () => {
    const content = `name: test
description: Main description here.
# This is a comment
- And this is a list item`;
    const result = parseSkillMarkdown(content, "fallback");
    expect(result.description).toBe("Main description here.");
    expect(result.description).not.toContain("#");
    expect(result.description).not.toContain("-");
  });

  it("strips > prefix from description", () => {
    const content = `name: test
description: > This is quoted`;
    const result = parseSkillMarkdown(content, "fallback");
    expect(result.description).toContain("quoted");
  });

  it("handles empty description", () => {
    const content = `name: test`;
    const result = parseSkillMarkdown(content, "fallback");
    expect(result.description).toBe("");
  });

  it("handles description with indented lines", () => {
    const content = `name: test
description: First line
  Second line indented
  Third line also indented`;
    const result = parseSkillMarkdown(content, "fallback");
    expect(result.description).toContain("First line");
    expect(result.description).toContain("Second line indented");
  });

  it("stops description at empty line", () => {
    const content = `name: test
description: Description line 1

  This should not be included`;
    const result = parseSkillMarkdown(content, "fallback");
    expect(result.description).toBe("Description line 1");
  });

  it("handles real SKILL.md format", () => {
    const content = `---
name: graphify
description: > Build or update a knowledge graph from any input (code, docs, papers, images). Produces clustered communities with HTML + JSON + audit report.
---

# Graphify

## Usage

Describe how to use this skill.`;
    const result = parseSkillMarkdown(content, "fallback-name");
    expect(result.name).toBe("graphify");
    expect(result.description).toContain("knowledge graph");
  });
});