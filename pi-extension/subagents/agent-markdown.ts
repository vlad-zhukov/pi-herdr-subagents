import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** Only agent definitions with YAML frontmatter are loadable. */
export function parseAgentMarkdown(content: string) {
  return /^---\r?\n[\s\S]*?\r?\n---/.test(content) ? parseFrontmatter(content) : null;
}
