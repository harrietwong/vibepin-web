const TITLE_MAX = 100;
const DESC_MAX = 800;
const ALT_MAX = 500;

function cap(value: string, max: number): string {
  const t = value.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export function validatePinCopy(input: {
  title: string;
  description: string;
  altText: string;
  tags: string[];
}) {
  return {
    title: cap(input.title, TITLE_MAX),
    description: cap(input.description, DESC_MAX),
    altText: cap(input.altText, ALT_MAX),
    tags: Array.from(new Set(input.tags.map(t => t.trim().replace(/^#/, "")).filter(Boolean))).slice(0, 12),
  };
}
