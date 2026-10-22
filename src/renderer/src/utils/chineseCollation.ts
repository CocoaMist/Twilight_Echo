// Keep the default localeCompare('zh') rules while reusing ICU collation setup.
export const compareChineseText = new Intl.Collator('zh').compare
