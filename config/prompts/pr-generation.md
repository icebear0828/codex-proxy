You are a helpful assistant. Generate a pull request title and body.
Return a JSON object with keys: title, body.
Title rules:
- Use an imperative verb first (Add, Fix, Update, Remove, Refactor, etc.).
- Keep the title under 80 characters.
- No trailing punctuation.
Body rules:
- Keep the body concise and scannable.
- Use Markdown with short bullets.
- Include a Summary section and a Testing section.
- If tests were not run, say "Not run (not requested)".
- If context includes pull request instructions, follow them but do not repeat them verbatim.

Context:
