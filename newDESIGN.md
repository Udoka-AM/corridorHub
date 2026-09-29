---
version: alpha
name: Accrium Monospace
description: A restrained, high-contrast investment identity with a technical monospace voice and airy editorial spacing.
colors:
  primary: "#0E1216"
  secondary: "#203838"
  tertiary: "#6F747A"
  neutral: "#E4E4E7"
  surface: "#FBFAF7"
  surface-strong: "#FFFFFF"
  on-surface: "#0E1216"
  on-surface-muted: "#66707A"
  border: "#E4E4E7"
  accent: "#203838"
  error: "#B42318"
typography:
  headline-display:
    fontFamily: "Space Mono"
    fontSize: "60px"
    fontWeight: 700
    lineHeight: 63px
    letterSpacing: "-1.5px"
  headline-lg:
    fontFamily: "Space Mono"
    fontSize: "43px"
    fontWeight: 400
    lineHeight: 52px
    letterSpacing: "2.75px"
  headline-md:
    fontFamily: "Space Mono"
    fontSize: "31px"
    fontWeight: 400
    lineHeight: 37px
    letterSpacing: "-0.45px"
  headline-sm:
    fontFamily: "Space Mono"
    fontSize: "22px"
    fontWeight: 400
    lineHeight: 26px
    letterSpacing: "0px"
  body-lg:
    fontFamily: "Space Mono"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 24px
    letterSpacing: "0px"
  body-md:
    fontFamily: "Space Mono"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 24px
    letterSpacing: "0px"
  body-sm:
    fontFamily: "Space Mono"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 20px
    letterSpacing: "0px"
  label-lg:
    fontFamily: "Space Mono"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 24px
    letterSpacing: "2.75px"
  label-md:
    fontFamily: "Space Mono"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 16px
    letterSpacing: "2.75px"
  label-sm:
    fontFamily: "Space Mono"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: 14px
    letterSpacing: "2.75px"
rounded:
  none: 0px
  sm: 4px
  md: 8px
  lg: 12px
  xl: 16px
  full: 9999px
spacing:
  xs: 8px
  sm: 20px
  md: 40px
  lg: 64px
  xl: 144px
  gutter: 40px
  margin: 64px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    padding: 8px 16px
    height: 40px
  button-primary-hover:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.sm}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.on-surface}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    padding: 8px 16px
    height: 40px
  button-tertiary:
    backgroundColor: "transparent"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
    rounded: "{rounded.none}"
    padding: 0px
  card:
    backgroundColor: "{colors.surface-strong}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.md}"
    padding: 32px
  input:
    backgroundColor: "{colors.surface-strong}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.sm}"
    padding: 8px 16px
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: 4px 12px
---
# Accrium Monospace

## Overview
Accrium feels like a disciplined, technical finance brand with a quiet industrial edge. The experience is spacious and minimal, using strong alignment, large negative space, and a restrained palette to communicate precision and trust. The typography and understated monochrome imagery make the site feel analytical rather than promotional.

## Colors
- **Primary (#0E1216):** Deep ink black used for headlines, body copy, and the strongest button fills. It provides the core contrast in an otherwise pale interface.
- **Secondary / Accent (#203838):** A muted blue-green technical accent that supports the brand’s industrial, systems-oriented tone. It should be used sparingly for emphasis, not decoration.
- **Tertiary (#6F747A):** A soft gray for secondary copy, labels, and less important interface text. It helps maintain hierarchy without introducing new visual noise.
- **Neutral / Border (#E4E4E7):** Light cool gray used for dividers, table borders, and subtle structural lines. It reinforces the grid without feeling heavy.
- **Surface (#FBFAF7):** The warm off-white page background that gives the layout its airy, editorial quality.
- **Surface strong (#FFFFFF):** Pure white for cards and inset panels where a cleaner lift from the page is needed.
- **On-surface (#0E1216):** Primary text and icon color on light backgrounds.
- **On-surface muted (#66707A):** Supporting text and metadata color with reduced emphasis.
- **Error (#B42318):** Reserved for validation and destructive feedback; it should remain rare in this system.

## Typography
The entire system is built on Space Mono, giving the brand a coded, engineering-adjacent voice. Headlines mix large scale with monospaced rhythm, while labels and navigation use generous letter spacing to create the signature all-caps, machine-readable feel. Body copy stays compact and highly legible at 16px with relaxed line height.

- **Headline display:** Bold and oversized for the hero message; use the tight negative letter spacing for dramatic, punchy statements.
- **Headline lg / md / sm:** Monospace editorial headings with varying optical weight; the larger styles can use wider tracking, while the smaller ones keep a more neutral rhythm.
- **Body lg / md / sm:** Standard paragraph text for descriptions, supporting copy, and explanatory content. Avoid adding additional font families or stylistic alternates.
- **Label lg / md / sm:** Used for navigation, section markers, and button text. Uppercase presentation and wide tracking are essential to the brand’s “technical label” character.

## Layout
The layout is built around a wide, fluid container with generous margins and strong horizontal breathing room. Sections are separated by large vertical intervals rather than heavy dividers, with spacing typically stepping through 8px, 20px, 40px, 64px, and 144px. Content blocks should align cleanly to a grid and feel spacious, with text columns kept narrow enough for comfortable reading.

Navigation and hero content sit in a clean top-aligned structure, while the image treatment stretches beyond the text column to create depth without clutter. Cards and feature blocks should use consistent internal padding, with 32px as a comfortable default. Use borders and whitespace before resorting to decorative containers.

## Elevation & Depth
The system is intentionally flat. Instead of dramatic shadows, hierarchy comes from contrast, spacing, and thin borders. Where depth is needed, use subtle cards with a faint shadow and a 1px border, but keep the effect understated so the interface remains architectural.

## Shapes
The shape language is crisp and minimal. Most surfaces use small radii, especially interactive controls and cards, with 4px rounding on buttons and 8px on larger containers. The overall feel should remain boxy and precise, avoiding soft or organic curves except for full pills and chips where utility calls for them.

## Components
- **Buttons:** Primary buttons use `button-primary` with a solid primary fill, light text, 8px by 16px padding, and a 40px height. Secondary buttons use `button-secondary` with transparent fill and a 1px dark outline. Tertiary actions should be text-only, matching `button-tertiary`, and should not look like emphasized controls.
- **Button states:** Hover states may subtly shift primary controls toward `button-primary-hover`, but should never introduce gradients or shadows. Keep pressed and disabled states simple and tonal.
- **Cards:** Use `card` for content groupings, with a white surface, 1px border, 32px padding, and very light shadow. Cards should feel like organized panels, not floating surfaces.
- **Inputs:** Inputs should mirror the card language: white surface, subtle border, small radius, and clear dark text. Focus states should rely on border or outline contrast rather than glow.
- **Chips:** Compact labels should use pill-shaped rounding and low-contrast surfaces. They work best for status tags, category markers, and short metadata.
- **Navigation links:** Top-level navigation is understated and spaced out, with label styling and no heavy hover treatment. The active or primary action can be a filled button to anchor the header.
- **Lists and data blocks:** Use grid lines, even column widths, and generous spacing to convey a structured systems view. Treat separators as functional, not decorative.

## Do's and Don'ts
- Do keep the interface quiet, airy, and highly aligned.
- Do use Space Mono consistently for all typography levels.
- Do rely on spacing and contrast for hierarchy before adding shadows.
- Do preserve the strong uppercase, tracked label style for navigation and metadata.
- Don't introduce bright colors, gradients, or playful illustration styles.
- Don't round components heavily; avoid soft, bubbly corners.
- Don't crowd sections or compress the vertical rhythm.
- Don't make primary actions look like pills or glossy modern SaaS buttons.

