## 2026-03-10 - Consistent Focus States and ARIA labels
**Learning:** Interactive elements like icon-only buttons need explicit 'aria-label' for screen readers. While 'focus-visible' is great for keyboard users to avoid clutter for mouse users, text inputs and select elements should still use 'focus:ring' because mouse users also expect a clear visual indicator of the active field.
**Action:** Apply 'aria-label' to all icon-only buttons and use a combination of 'focus:ring' and 'focus-visible:ring-offset' for inputs to ensure a balanced UX for all input methods.
