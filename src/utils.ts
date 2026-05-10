export function hasEnglishCharacters(text: string): boolean {
  return /[a-zA-Z]{2,}/.test(text);
}

export function tokenizeForMatch(text: string): Set<string> {
  const tokens: string[] = [];
  const englishToken = text.match(/[a-zA-Z]{2,}/g);
  if (englishToken) tokens.push(...englishToken.map(t => t.toLowerCase()));
  return new Set(tokens);
}

export function keywordMatch(query: string, skillKeywords: string[]): boolean {
  if (skillKeywords.length === 0) return false;
  const queryTokens = tokenizeForMatch(query);
  if (queryTokens.size === 0) return false;
  const kwSet = new Set(skillKeywords.map(k => k.toLowerCase()));
  for (const token of queryTokens) {
    if (kwSet.has(token)) return true;
  }
  return false;
}

export function parseSkillMarkdown(content: string, fallbackName: string): { name: string; description: string } {
  const lines = content.split("\n");
  let name = fallbackName;
  let description = "";
  let inDescription = false;
  const descriptionLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("name:")) {
      name = line.replace("name:", "").trim();
    } else if (line.startsWith("description:")) {
      inDescription = true;
      const desc = line.replace("description:", "").replace(/^>\s*/, "").trim();
      if (desc) descriptionLines.push(desc);
    } else if (inDescription && line.trim() === "") {
      inDescription = false;
    } else if (inDescription && line.startsWith(" ")) {
      const trimmed = line.trim().replace(/^>\s*/, "");
      if (trimmed) descriptionLines.push(trimmed);
    } else if (inDescription) {
      const trimmed = line.trim().replace(/^>\s*/, "");
      if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("-")) {
        descriptionLines.push(trimmed);
      }
    }
  }

  description = descriptionLines.join(" ").trim();
  return { name, description };
}
