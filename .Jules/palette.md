
## 2025-05-14 - [Accessible Icon Buttons and Focus Visibility]
**Learning:** Icon-only buttons often lack descriptive labels for screen readers and visible focus indicators for keyboard-only users. Using 'aria-label' with localized strings and 'focus-visible' utility classes (e.g., 'focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 outline-none') provides a significant accessibility boost without impacting mouse users.
**Action:** Always include 'aria-label' for icon buttons and apply 'focus-visible' ring styles to all interactive elements to ensure clear keyboard navigation.
