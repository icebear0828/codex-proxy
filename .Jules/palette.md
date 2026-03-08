## 2025-05-15 - [Consistent Focus Indicators & ARIA labels]
**Learning:** Many interactive components (CopyButton, toggle buttons, delete actions) lacked visible focus states and accessible labels, making the app difficult to navigate via keyboard or screen reader.
**Action:** Always implement 'focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 dark:focus-visible:ring-offset-bg-dark outline-none' for interactive elements and ensure all icon-only buttons have descriptive 'aria-label' attributes.
