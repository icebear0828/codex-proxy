## 2025-05-22 - [Accessibility & Feedback]
**Learning:** Icon-only buttons (theme toggle, language toggle) without ARIA labels are a significant accessibility gap in this app. Additionally, async operations like "Add Account" lacked visual feedback, leading to a potentially confusing experience or duplicate submissions.
**Action:** Always add `aria-label` to icon-only buttons. Use a `Spinner` component and disabled states for all async buttons to provide clear feedback and prevent race conditions.
