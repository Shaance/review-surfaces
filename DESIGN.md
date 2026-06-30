# Design Language: Cursor: The best coding agent

> Extracted from `https://cursor.com` on May 28, 2026
> 2092 elements analyzed

This document describes the complete design language of the website. It is structured for AI/LLM consumption — use it to faithfully recreate the visual design in any framework.

## Color Palette

### Primary Colors

| Role | Hex | RGB | HSL | Usage Count |
|------|-----|-----|-----|-------------|
| Primary | `#f7f7f4` | rgb(247, 247, 244) | hsl(60, 16%, 96%) | 135 |
| Secondary | `#26251e` | rgb(38, 37, 30) | hsl(53, 12%, 13%) | 2909 |
| Accent | `#e6e5e0` | rgb(230, 229, 224) | hsl(50, 11%, 89%) | 26 |

### Neutral Colors

| Hex | HSL | Usage Count |
|-----|-----|-------------|
| `#050503` | hsl(60, 25%, 2%) | 1018 |
| `#141414` | hsl(0, 0%, 8%) | 90 |
| `#ffffff` | hsl(0, 0%, 100%) | 9 |
| `#d9d5cf` | hsl(36, 12%, 83%) | 1 |
| `#4a443b` | hsl(36, 11%, 26%) | 1 |
| `#b6b9be` | hsl(218, 6%, 73%) | 1 |
| `#3c3935` | hsl(34, 6%, 22%) | 1 |

### Background Colors

Used on large-area elements: `#f7f7f4`, `#f2f1ed`, `#d9d5cf`, `#b6b9be`, `#e6e5e0`, `#ebeae5`

### Text Colors

Text color palette: `#000000`, `#26251e`, `#f7f7f4`, `#050503`, `#1f8a65`, `#cf2d56`, `#3a6a9f`, `#f54e00`, `#ffffff`, `#c08532`

### Gradients

```css
background-image: linear-gradient(oklab(0.263084 -0.00230259 0.0124794 / 0.05) 0%, oklab(0.263084 -0.00230259 0.0124794 / 0.05) 100%), linear-gradient(rgb(242, 241, 237) 0%, rgb(242, 241, 237) 100%);
```

```css
background-image: linear-gradient(in oklab, rgb(242, 241, 237) 0%, rgba(0, 0, 0, 0) 100%);
```

```css
background-image: linear-gradient(to top in oklab, rgb(242, 241, 237) 0%, rgba(0, 0, 0, 0) 100%);
```

```css
background-image: linear-gradient(90deg, oklab(0.263084 -0.00230259 0.0124794 / 0.6) 0%, oklab(0.263084 -0.00230259 0.0124794 / 0.6) 30%, color(srgb 0.14902 0.145098 0.117647 / 0.92) 55%, oklab(0.263084 -0.00230259 0.0124794 / 0.6) 70%, oklab(0.263084 -0.00230259 0.0124794 / 0.6) 100%);
```

### Full Color Inventory

| Hex | Contexts | Count |
|-----|----------|-------|
| `#26251e` | text, border, background | 2909 |
| `#050503` | text, border, background | 1018 |
| `#f7f7f4` | background, text, border | 135 |
| `#141414` | text, border | 90 |
| `#9e94d5` | text, border | 28 |
| `#e6e5e0` | background | 26 |
| `#f54e00` | text, border | 22 |
| `#c08532` | background, text, border | 21 |
| `#1f8a65` | text, border | 20 |
| `#b3003f` | text, border | 20 |
| `#aa52a2` | text, border | 14 |
| `#ffffff` | text, border | 9 |
| `#3a6a9f` | background, border, text | 8 |
| `#db704b` | text, border | 8 |
| `#cf2d56` | text, border | 6 |
| `#4ade80` | text, border | 6 |
| `#6049b3` | text, border | 6 |
| `#34785c` | background, border | 2 |
| `#e3ebf3` | background | 1 |
| `#d9d5cf` | background | 1 |
| `#4a443b` | background | 1 |
| `#b6b9be` | background | 1 |
| `#3c3935` | background | 1 |
| `#22c55e` | background | 1 |

## Typography

### Font Families

- **CursorGothic** — used for all (1284 elements)
- **berkeleyMono** — used for body (281 elements)
- **EB Garamond** — used for body (158 elements)
- **Lato** — used for all (71 elements)
- **CursorIcons16** — used for body (6 elements)
- **Times** — used for body (3 elements)

### Type Scale

| Size (px) | Size (rem) | Weight | Line Height | Letter Spacing | Used On |
|-----------|------------|--------|-------------|----------------|---------|
| 72px | 4.5rem | 400 | 79.2px | -2.16px | h2 |
| 36px | 2.25rem | 400 | 43.2px | -0.72px | header, button, svg, path |
| 26px | 1.625rem | 400 | 32.5px | -0.325px | h1 |
| 22px | 1.375rem | 400 | 28.6px | -0.11px | h3, div, h2 |
| 20px | 1.25rem | 700 | 31px | normal | h1 |
| 19.2px | 1.2rem | 500 | 28.8px | normal | span |
| 17.28px | 1.08rem | 400 | 23.328px | normal | div, p, span, button |
| 16px | 1rem | 400 | 24px | normal | html, head, meta, link |
| 14px | 0.875rem | 400 | 14px | normal | a, button, span, div |
| 13px | 0.8125rem | 400 | 17.3333px | normal | div, textarea, p, span |
| 12px | 0.75rem | 400 | 16px | normal | div, button, span, svg |
| 11px | 0.6875rem | 500 | 14px | 0.0484px | div, span, button, svg |
| 10px | 0.625rem | 600 | 11px | normal | span |
| 6px | 0.375rem | 500 | 6px | normal | div |

### Heading Scale

```css
h2 { font-size: 72px; font-weight: 400; line-height: 79.2px; }
h2 { font-size: 36px; font-weight: 400; line-height: 43.2px; }
h1 { font-size: 26px; font-weight: 400; line-height: 32.5px; }
h3 { font-size: 22px; font-weight: 400; line-height: 28.6px; }
h1 { font-size: 20px; font-weight: 700; line-height: 31px; }
h1 { font-size: 16px; font-weight: 400; line-height: 24px; }
h2 { font-size: 14px; font-weight: 400; line-height: 14px; }
```

### Body Text

```css
body { font-size: 12px; font-weight: 400; line-height: 16px; }
```

### Font Weights in Use

`400` (2056x), `500` (24x), `600` (11x), `700` (1x)

## Spacing

| Token | Value | Rem |
|-------|-------|-----|
| spacing-0 | 0px | 0rem |
| spacing-28 | 28px | 1.75rem |
| spacing-45 | 45px | 2.8125rem |
| spacing-48 | 48px | 3rem |
| spacing-52 | 52px | 3.25rem |
| spacing-56 | 56px | 3.5rem |
| spacing-64 | 64px | 4rem |
| spacing-67 | 67px | 4.1875rem |
| spacing-90 | 90px | 5.625rem |
| spacing-101 | 101px | 6.3125rem |
| spacing-112 | 112px | 7rem |
| spacing-134 | 134px | 8.375rem |
| spacing-163 | 163px | 10.1875rem |
| spacing-215 | 215px | 13.4375rem |

## Border Radii

| Label | Value | Count |
|-------|-------|-------|
| xs | 2px | 10 |
| md | 8px | 30 |
| lg | 12px | 1 |

## Box Shadows

**sm** — blur: 0px
```css
box-shadow: rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.02) 0px 0px 16px 0px, rgba(0, 0, 0, 0.008) 0px 0px 8px 0px;
```

**sm** — blur: 0px
```css
box-shadow: rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgb(38, 37, 30) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px;
```

**sm** — blur: 0px
```css
box-shadow: rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.1) 0px 10px 15px -3px, rgba(0, 0, 0, 0.1) 0px 4px 6px -4px;
```

**sm** — blur: 0px
```css
box-shadow: oklab(0.263084 -0.00230259 0.0124794 / 0.1) 0px 0px 0px 1px, rgba(0, 0, 0, 0.28) 0px 18px 36px -18px;
```

**sm** — blur: 0px
```css
box-shadow: rgb(235, 234, 229) 0px 0px 0px 2px;
```

**xl** — blur: 30px
```css
box-shadow: rgba(0, 0, 0, 0.35) 0px 8px 30px 0px, rgba(0, 0, 0, 0.15) 0px 0px 0px 0.5px;
```

**xl** — blur: 50px
```css
box-shadow: rgba(0, 0, 0, 0.25) 0px 25px 50px -12px, rgba(0, 0, 0, 0.15) 0px 12px 24px -8px, oklab(0.263084 -0.00230259 0.0124794 / 0.1) 0px 0px 0px 0.5px;
```

**xl** — blur: 70px
```css
box-shadow: rgba(0, 0, 0, 0.3) 0px 22px 70px 4px, rgba(0, 0, 0, 0.15) 0px 0px 0px 0.5px;
```

**xl** — blur: 70px
```css
box-shadow: rgba(0, 0, 0, 0.14) 0px 28px 70px 0px, rgba(0, 0, 0, 0.1) 0px 14px 32px 0px, oklab(0.263084 -0.00230259 0.0124794 / 0.1) 0px 0px 0px 1px;
```

## CSS Custom Properties

### Colors

```css
--color-bg: var(--color-theme-bg);
--color-text-primary: var(--color-theme-text);
--color-text-muted: var(--color-theme-text-sec);
--color-text-secondary: var(--color-theme-text-sec);
--color-border: var(--color-theme-border-02);
--color-accent: var(--color-theme-accent);
--color-code-bg: var(--color-theme-card-hex);
--color-code-text: var(--color-theme-text);
--color-bg-hover: var(--color-theme-card-hover-hex);
--color-border-bright: var(--color-theme-border-02-5);
--color-success: var(--color-theme-product-ansi-green);
--color-success-bg: color-mix(in srgb, var(--color-theme-product-ansi-green) 15%, transparent);
--color-error: var(--color-theme-product-ansi-red);
--color-error-bg: color-mix(in srgb, var(--color-theme-product-ansi-red) 15%, transparent);
--color-warning: var(--color-theme-accent);
--color-warning-bg: color-mix(in srgb, var(--color-theme-accent) 15%, transparent);
--color-accent-bg: color-mix(in srgb, var(--color-theme-accent) 10%, transparent);
--color-accent-bg-strong: color-mix(in srgb, var(--color-theme-accent) 25%, transparent);
--color-info: var(--color-theme-border-03);
--color-bg-elevated: var(--color-theme-card-hex);
--color-timeline-thinking: #dfa88f;
--color-timeline-grep: #9fc9a2;
--color-timeline-read: #9fbbe0;
--color-timeline-edit: #c0a8dd;
--color-theme-button-bg: #26251e;
--color-theme-fg-01: color-mix(in oklab, #26251e 1%, transparent);
--color-slate-200: lab(91.7353% -.998765 -4.76968);
--prose-code-border-radius: 4px;
--color-slate-500: lab(48.0876% -2.03595 -16.5814);
--tw-inset-ring-shadow: 0 0 #0000;
--color-theme-product-editor: #f7f7f4;
--color-theme-border-01-5: color-mix(in oklab, #26251e 5%, transparent);
--color-gray-300: lab(85.1236% -.612259 -3.7138);
--color-gray-500: lab(47.7841% -.393182 -10.0268);
--color-theme-fg-02-5: color-mix(in oklab, #26251e 2.5%, transparent);
--color-green-500: lab(70.5521% -66.5147 45.8073);
--color-white: #fff;
--color-gray-100: lab(96.1596% -.0823438 -1.13575);
--color-theme-border-02-5: color-mix(in oklab, #26251e 20%, transparent);
--color-green-900: lab(30.797% -29.6927 17.382);
--color-blue-800: lab(30.2514% 27.7853 -70.2699);
--color-theme-border-01: color-mix(in oklab, #26251e 2.5%, transparent);
--color-theme-button-sec-bg: transparent;
--ease-out-spring: cubic-bezier(.25, 1, .5, 1);
--color-theme-product-chrome: #f2f1ed;
--color-green-600: lab(59.0978% -58.6621 41.2579);
--color-theme-button-sec-text: #26251e;
--color-theme-fg: #26251e;
--color-theme-border-03: color-mix(in oklab, #26251e 60%, transparent);
--color-gray-950: lab(1.90334% .278696 -5.48866);
--color-gray-600: lab(35.6337% -1.58697 -10.8425);
--color-purple-400: lab(63.6946% 47.6127 -59.2066);
--color-blue-600: lab(44.0605% 29.0279 -86.0352);
--color-theme-fg-07-5: color-mix(in oklab, #26251e 7.5%, transparent);
--tw-border-style: solid;
--color-theme-fg-08: color-mix(in oklab, #26251e 8%, transparent);
--color-red-600: lab(48.4493% 77.4328 61.5452);
--color-blue-50: lab(96.492% -1.14644 -5.11479);
--color-theme-fg-15: color-mix(in oklab, #26251e 15%, transparent);
--color-black: #000;
--color-theme-card-03: linear-gradient(color-mix(in oklab, #26251e 5%, transparent) 0% 100%), linear-gradient(#f2f1ed 0% 100%);
--color-theme-button-text: #f7f7f4;
--color-theme-text-mid: color-mix(in oklab, #26251e 50%, transparent);
--color-theme-product-ansi-red: #cf2d56;
--color-theme-button-sec-border: color-mix(in oklab, #26251e 60%, transparent);
--tw-ring-shadow: 0 0 #0000;
--color-theme-card-hover-light-hex: #f0efeb;
--color-theme-card-hover-border: color-mix(in oklab, #26251e 10%, transparent);
--color-theme-fg-10: color-mix(in oklab, #26251e 10%, transparent);
--color-theme-card-02: linear-gradient(color-mix(in oklab, #26251e 2.5%, transparent) 0% 100%), linear-gradient(#f2f1ed 0% 100%);
--color-theme-border: color-mix(in oklab, #26251e 2.5%, transparent);
--color-theme-bg: #f7f7f4;
--color-theme-card-02-hex: #ebeae5;
--color-gray-50: lab(98.2596% -.247031 -.706708);
--tw-ring-offset-color: #fff;
--color-theme-product-text: color-mix(in oklab, #26251e 92%, transparent);
--color-red-500: lab(55.4814% 75.0732 48.8528);
--color-theme-button-hover-bg: #3b3a33;
--tw-ring-offset-width: 0px;
--color-theme-product-text-sec: color-mix(in oklab, #26251e 60%, transparent);
--color-theme-border-02: color-mix(in oklab, #26251e 10%, transparent);
--color-indigo-600: lab(38.4009% 52.6132 -92.3857);
--color-theme-fg-20: color-mix(in oklab, #26251e 20%, transparent);
--color-theme-card: linear-gradient(#f2f1ed 0% 100%);
--color-theme-product-removed-line-background: color-mix(in srgb, #cf2d56 6%, transparent);
--color-theme-fg-05: color-mix(in oklab, #26251e 5%, transparent);
--tw-ring-offset-shadow: 0 0 #0000;
--color-theme-text: #26251e;
--color-theme-card-04-hex: #e1e0db;
--color-gray-800: lab(16.1051% -1.18239 -11.7533);
--color-theme-button-hover-text: #f7f7f4;
--color-green-50: lab(98.1563% -5.60117 2.75915);
--color-theme-card-hover-hex: #ebeae5;
--color-theme-fg-02: #3b3a33;
--color-green-800: lab(37.4616% -36.7971 22.9692);
--color-theme-card-01-hex: #f0efeb;
--prose-pre-bg: color-mix(in oklab, #26251e 2.5%, transparent);
--color-gray-900: lab(8.11897% .811279 -12.254);
--color-blue-900: lab(26.1542% 15.7545 -51.5504);
--color-theme-text-tertiary: color-mix(in oklab, #26251e 40%, transparent);
--color-theme-product-text-tertiary: color-mix(in oklab, #26251e 40%, transparent);
--color-theme-product-line-inserted-line-background: color-mix(in srgb, #1f8a65 8%, transparent);
--color-gray-700: lab(27.1134% -.956401 -12.3224);
--color-theme-text-sec: color-mix(in oklab, #26251e 60%, transparent);
--color-theme-card-hex: #f2f1ed;
--color-theme-card-03-hex: #e6e5e0;
--prose-code-border: color-mix(in oklab, #26251e 2.5%, transparent);
--color-theme-button-hover-border: #3b3a33;
--color-gray-200: lab(91.6229% -.159115 -2.26791);
--color-theme-product-ansi-green: #1f8a65;
--color-theme-accent: #f54e00;
--prose-code-bg: #f2f1ed;
--color-theme-card-warm-hex: #f3ede6;
```

### Spacing

```css
--spacing-xs: var(--spacing-g0\.25);
--spacing-sm: var(--spacing-g0\.5);
--spacing-md: var(--spacing-g1);
--spacing-lg: var(--spacing-g1\.5);
--spacing-xl: var(--spacing-g2);
--spacing-2xl: var(--spacing-g3);
--spacing-v9/12: calc(1rem * 1.4 * 9 / 12);
--spacing-prose-wide: 96ch;
--spacing-v1.5: calc(1rem * 1.4 * 1.5);
--spacing-v5: calc(1rem * 1.4 * 5);
--spacing-g2.5: calc(calc(10rem / 16) * 2.5);
--spacing-v3/12: calc(1rem * 1.4 * 3 / 12);
--button-padding-md-sm: .6em 1.25em .62em;
--spacing-v7/12: calc(1rem * 1.4 * 7 / 12);
--tw-space-x-reverse: 0;
--spacing-v2/12: calc(1rem * 1.4 * 2 / 12);
--spacing-v2.5: calc(1rem * 1.4 * 2.5);
--spacing-v6/12: calc(1rem * 1.4 * 6 / 12);
--spacing-g1.75: calc(calc(10rem / 16) * 1.75);
--button-padding-default: .78em 1.35em .8em;
--spacing-v1: calc(1rem * 1.4);
--spacing: .25rem;
--spacing-g0.5: calc(calc(10rem / 16) * .5);
--spacing-v10/12: calc(1rem * 1.4 * 10 / 12);
--spacing-v4: calc(1rem * 1.4 * 4);
--spacing-g2: calc(calc(10rem / 16) * 2);
--spacing-g1: calc(calc(10rem / 16) * 1);
--spacing-prose-medium-wide: 80ch;
--tw-space-y-reverse: 0;
--spacing-v2.5/12: calc(1rem * 1.4 * 2.5 / 12);
--spacing-v5/12: calc(1rem * 1.4 * 5 / 12);
--spacing-v1.25: calc(1rem * 1.4 * 1.25);
--spacing-v3: calc(1rem * 1.4 * 3);
--spacing-g0.75: calc(calc(10rem / 16) * .75);
--spacing-v4.5: calc(1rem * 1.4 * 4.5);
--button-padding-sm: .4em .75em .42em;
--grid-gap: calc(12rem / 15);
--spacing-v6: calc(1rem * 1.4 * 6);
--spacing-prose-narrow: 48ch;
--button-padding-xs: .15em .5em;
--spacing-v1/12: calc(1rem * 1.4 * 1 / 12);
--spacing-g1.5: calc(calc(10rem / 16) * 1.5);
--spacing-v2: calc(1rem * 1.4 * 2);
--spacing-v4/12: calc(1rem * 1.4 * 4 / 12);
--spacing-v8/12: calc(1rem * 1.4 * 8 / 12);
--katex-font-size: 1.15rem;
--spacing-v8: calc(1rem * 1.4 * 8);
--spacing-g0.25: calc(calc(10rem / 16) * .25);
--spacing-g3: calc(calc(10rem / 16) * 3);
--spacing-g1.25: calc(calc(10rem / 16) * 1.25);
```

### Typography

```css
--font-mono: var(--font-berkeley-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
--text-base--line-height: calc(1.5 / 1);
--font-system: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
--text-slack-lg: 1rem;
--font-weight-bold: 700;
--text-xs--line-height: calc(1 / .75);
--leading-2xsnug: 1.15;
--text-xl: 3.25rem;
--leading-relaxed: 1.625;
--leading-snug: 1.25;
--leading-xsnug: 1.2;
--leading-product-base: 1.33333;
--text-md: 1.375rem;
--text-2xl--line-height: calc(2 / 1.5);
--text-sm: .875rem;
--leading-product-sm: 1.27273;
--leading-tight: 1.1;
--tracking-lg: -.02em;
--tracking-sm: .01em;
--text-4xl--line-height: calc(2.5 / 2.25);
--tracking-tight: -.025em;
--text-2xl: 4.5rem;
--tracking-product-sm: .0044em;
--text-lg: 2.25rem;
--leading-normal: 1.5;
--text-product-lg: .8125rem;
--tracking-2xl: -.03em;
--text-lg--line-height: calc(1.75 / 1.125);
--tracking-md-lg: -.0125em;
--font-sans: "CursorGothic", "CursorGothic Fallback", system-ui, Helvetica Neue, Helvetica, Arial, sans-serif;
--default-font-family: "CursorGothic", "CursorGothic Fallback", system-ui, Helvetica Neue, Helvetica, Arial, sans-serif;
--font-berkeley-mono: "berkeleyMono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace;
--tracking-xl: -.025em;
--leading-cozy: 1.4;
--tracking-base: .005em;
--text-product-base: .75rem;
--text-md-sm: 1.125rem;
--leading-product-base-mono: 1.25rem;
--font-weight-semibold: 600;
--tracking-wide: .025em;
--text-slack-sm: .75rem;
--tracking-md: -.005em;
--text-product-sm: .6875rem;
--text-4xl: 2.25rem;
--text-md-lg: 1.625rem;
--text-sm--line-height: calc(1.25 / .875);
--text-3xl--line-height: calc(2.25 / 1.875);
--text-3xl: 1.875rem;
--text-xs: .75rem;
--font-weight-medium: 500;
--font-weight-normal: 400;
--font-serif: "EB Garamond", Iowan Old Style, Palatino Linotype, URW Palladio L, P052, ui-serif, Georgia, Cambria, Times New Roman, Times, serif;
--text-slack-base: .875rem;
--leading-snug-plus: 1.3;
--text-base: 1rem;
--default-mono-font-family: "berkeleyMono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
```

### Shadows

```css
--tw-inset-shadow-alpha: 100%;
--tw-inset-shadow: 0 0 #0000;
--tw-shadow-alpha: 100%;
--shadow-outline-theme: 0 0 0 1px color-mix(in oklab, #26251e 10%, transparent);
--tw-drop-shadow-alpha: 100%;
--shadow-flyout: 0 0 1rem #00000005, 0 0 .5rem #00000002;
--tw-shadow: 0 0 #0000;
```

### Radii

```css
--radius-2xs: 2px;
--radius-sm: .25rem;
--radius-2xl: 1rem;
--radius-md: 8px;
--radius-lg: .5rem;
--radius-xs: 4px;
--radius-xl: .75rem;
```

### Other

```css
--transition-fast: var(--duration);
--container-md: 28rem;
--aspect-video: 16 / 9;
--blur-lg: 16px;
--tw-outline-style: solid;
--site-sticky-top: 64px;
--tw-gradient-from: rgba(0, 0, 0, 0);
--tw-gradient-to: rgba(0, 0, 0, 0);
--v: 1rem * 1.4;
--_number-flow-d-opacity: 0;
--tw-gradient-via-position: 50%;
--tw-gradient-to-position: 100%;
--default-transition-duration: .15s;
--animate-pulse: pulse 2s cubic-bezier(.4, 0, .6, 1) infinite;
--container-xs: 20rem;
--site-header-height: 52px;
--prose-bullets: color-mix(in oklab, #26251e 40%, transparent);
--default-transition-timing-function: cubic-bezier(.4, 0, .2, 1);
--_number-flow-d: 0;
--prose-code: #26251e;
--tw-translate-z: 0;
--tw-gradient-via: rgba(0, 0, 0, 0);
--tw-scale-y: 1;
--container-3xl: 48rem;
--tw-translate-y: 0;
--ease-out: cubic-bezier(0, 0, .2, 1);
--tw-content: "";
--tw-translate-x: 0;
--prose-captions: color-mix(in oklab, #26251e 60%, transparent);
--container-xl: 36rem;
--prose-headings: #26251e;
--_number-flow-dx: 0px;
--media-range-thumb-display: none;
--tw-scale-z: 1;
--prose-pre-code: #26251e;
--container-sm: 24rem;
--duration-slow: .25s;
--tw-scroll-snap-strictness: proximity;
--container-lg: 32rem;
--g: calc(10rem / 16);
--_number-flow-d-width: 0;
--max-width-container: 1300px;
--tw-gradient-from-position: 0%;
--ease-in-out: cubic-bezier(.4, 0, .2, 1);
--animate-gallery-marquee-item-slide-up: gallery-marquee-item-slide-up 1s cubic-bezier(.25, 1, .5, 1) both;
--container-5xl: 64rem;
--container-2xs: 18rem;
--blur-md: 12px;
--animate-spin: spin 1s linear infinite;
--container-4xl: 56rem;
--tw-divide-y-reverse: 0;
--breakpoint-md: 660px;
--container-2xl: 42rem;
--prose-hr: color-mix(in oklab, #26251e 10%, transparent);
--tw-scale-x: 1;
--duration: .14s;
--container-7xl: 80rem;
--prose-body: #26251e;
--blur-sm: 8px;
```

### Dependencies

```css
--color-bg: --color-theme-bg;
--color-text-primary: --color-theme-text;
--color-text-muted: --color-theme-text-sec;
--color-text-secondary: --color-theme-text-sec;
--color-border: --color-theme-border-02;
--color-accent: --color-theme-accent;
--color-code-bg: --color-theme-card-hex;
--color-code-text: --color-theme-text;
--color-bg-hover: --color-theme-card-hover-hex;
--color-border-bright: --color-theme-border-02-5;
--color-success: --color-theme-product-ansi-green;
--color-success-bg: --color-theme-product-ansi-green;
--color-error: --color-theme-product-ansi-red;
--color-error-bg: --color-theme-product-ansi-red;
--color-warning: --color-theme-accent;
--color-warning-bg: --color-theme-accent;
--color-accent-bg: --color-theme-accent;
--color-accent-bg-strong: --color-theme-accent;
--color-info: --color-theme-border-03;
--font-mono: --font-berkeley-mono;
--spacing-xs: --spacing-g0;
--spacing-sm: --spacing-g0;
--spacing-md: --spacing-g1;
--spacing-lg: --spacing-g1;
--spacing-xl: --spacing-g2;
--spacing-2xl: --spacing-g3;
--transition-fast: --duration;
--color-bg-elevated: --color-theme-card-hex;
```

### Semantic

```css
success: [object Object];
warning: [object Object];
error: [object Object];
info: [object Object];
```

## Breakpoints

| Name | Value | Type |
|------|-------|------|
| sm | 600px | max-width |
| md | 767px | max-width |
| md | 768px | max-width |
| 900px | 900px | min-width |
| xl | 1279px | max-width |

## Transitions & Animations

**Easing functions:** `[object Object]`, `[object Object]`, `[object Object]`, `[object Object]`

**Durations:** `0.5s`, `0.14s`, `0s`, `0.2s`, `0.15s`

### Common Transitions

```css
transition: all;
transition: opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1);
transition: opacity 0.14s cubic-bezier(0.25, 1, 0.5, 1);
transition: transform 0.14s cubic-bezier(0.25, 1, 0.5, 1);
transition: opacity 0.14s cubic-bezier(0.25, 1, 0.5, 1), transform 0.14s cubic-bezier(0.25, 1, 0.5, 1), visibility 0s linear 0.14s;
transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
transition: color 0.15s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.15s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.15s cubic-bezier(0.4, 0, 0.2, 1), outline-color 0.15s cubic-bezier(0.4, 0, 0.2, 1), text-decoration-color 0.15s cubic-bezier(0.4, 0, 0.2, 1), fill 0.15s cubic-bezier(0.4, 0, 0.2, 1), stroke 0.15s cubic-bezier(0.4, 0, 0.2, 1), --tw-gradient-from 0.15s cubic-bezier(0.4, 0, 0.2, 1), --tw-gradient-via 0.15s cubic-bezier(0.4, 0, 0.2, 1), --tw-gradient-to 0.15s cubic-bezier(0.4, 0, 0.2, 1);
transition: opacity 0.15s cubic-bezier(0.4, 0, 0.2, 1);
transition: color 0.15s;
transition: 0.15s cubic-bezier(0.4, 0, 0.2, 1);
```

### Keyframe Animations

**newsletter-submit-pulse**
```css
@keyframes newsletter-submit-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
```

**gallery-marquee-item-slide-up**
```css
@keyframes gallery-marquee-item-slide-up {
  0% { opacity: 0; transform: translateY(25%); }
  100% { opacity: 1; transform: translate(0px); }
}
```

**spin**
```css
@keyframes spin {
  100% { transform: rotate(360deg); }
}
```

**pulse**
```css
@keyframes pulse {
  50% { opacity: 0.5; }
}
```

**pulse-emit**
```css
@keyframes pulse-emit {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.1); }
}
```

**pulse-bit**
```css
@keyframes pulse-bit {
  0% { transform: scale(1); }
  100% { transform: scale(1.1); }
}
```

**swipe-out-left**
```css
@keyframes swipe-out-left {
  0% { transform: var(--y) translateX(var(--swipe-amount-x)); opacity: 1; }
  100% { transform: var(--y) translateX(calc(var(--swipe-amount-x) - 100%)); opacity: 0; }
}
```

**swipe-out-right**
```css
@keyframes swipe-out-right {
  0% { transform: var(--y) translateX(var(--swipe-amount-x)); opacity: 1; }
  100% { transform: var(--y) translateX(calc(var(--swipe-amount-x) + 100%)); opacity: 0; }
}
```

**swipe-out-up**
```css
@keyframes swipe-out-up {
  0% { transform: var(--y) translateY(var(--swipe-amount-y)); opacity: 1; }
  100% { transform: var(--y) translateY(calc(var(--swipe-amount-y) - 100%)); opacity: 0; }
}
```

**swipe-out-down**
```css
@keyframes swipe-out-down {
  0% { transform: var(--y) translateY(var(--swipe-amount-y)); opacity: 1; }
  100% { transform: var(--y) translateY(calc(var(--swipe-amount-y) + 100%)); opacity: 0; }
}
```

## Component Patterns

Detected UI component patterns and their most common styles:

### Buttons (100 instances)

```css
.button {
  background-color: rgb(38, 37, 30);
  color: rgb(38, 37, 30);
  font-size: 16px;
  font-weight: 400;
  padding-top: 0px;
  padding-right: 0px;
  border-radius: 0px;
}
```

### Cards (89 instances)

```css
.card {
  background-color: rgb(242, 241, 237);
  border-radius: 4px;
  box-shadow: rgba(0, 0, 0, 0.14) 0px 28px 70px 0px, rgba(0, 0, 0, 0.1) 0px 14px 32px 0px, oklab(0.263084 -0.00230259 0.0124794 / 0.1) 0px 0px 0px 1px;
  padding-top: 0px;
  padding-right: 0px;
}
```

### Inputs (3 instances)

```css
.input {
  color: rgb(38, 37, 30);
  border-color: rgb(38, 37, 30);
  border-radius: 0px;
  font-size: 13px;
  padding-top: 8px;
  padding-right: 8px;
}
```

### Links (84 instances)

```css
.link {
  color: rgb(38, 37, 30);
  font-size: 14px;
  font-weight: 400;
}
```

### Navigation (51 instances)

```css
.navigatio {
  background-color: rgb(247, 247, 244);
  color: rgb(38, 37, 30);
  padding-top: 4.66667px;
  padding-bottom: 4.66667px;
  padding-left: 0px;
  padding-right: 0px;
  position: static;
  box-shadow: rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.02) 0px 0px 16px 0px, rgba(0, 0, 0, 0.008) 0px 0px 8px 0px;
}
```

### Footer (32 instances)

```css
.foote {
  background-color: rgb(242, 241, 237);
  color: rgb(38, 37, 30);
  padding-top: 4.66667px;
  padding-bottom: 4.66667px;
  font-size: 14px;
}
```

### Modals (1 instances)

```css
.modal {
  border-radius: 0px;
  padding-top: 0px;
  padding-right: 0px;
}
```

### Dropdowns (2 instances)

```css
.dropdown {
  background-color: rgb(242, 241, 237);
  border-radius: 8px;
  box-shadow: oklab(0.263084 -0.00230259 0.0124794 / 0.1) 0px 0px 0px 1px, rgba(0, 0, 0, 0.28) 0px 18px 36px -18px;
  border-color: rgb(38, 37, 30);
  padding-top: 0px;
}
```

### Tables (1 instances)

```css
.table {
  border-color: rgba(38, 37, 30, 0.55);
  cell-style: [object Object];
}
```

### Badges (5 instances)

```css
.badge {
  color: oklab(0.263084 -0.00230259 0.0124794 / 0.5);
  font-size: 14px;
  font-weight: 400;
  padding-top: 5.6px;
  padding-right: 10.5px;
  border-radius: 3.35544e+07px;
}
```

### Avatars (11 instances)

```css
.avatar {
  border-radius: 3.35544e+07px;
  background-color: rgb(230, 229, 224);
}
```

### Tabs (6 instances)

```css
.tab {
  background-color: rgb(247, 247, 244);
  color: rgb(38, 37, 30);
  font-size: 14px;
  font-weight: 400;
  padding-top: 0px;
  padding-right: 8px;
  border-color: oklab(0.263084 -0.00230259 0.0124794 / 0.1);
  border-radius: 0px;
}
```

### Tooltips (1 instances)

```css
.tooltip {
  background-color: rgb(227, 235, 243);
  color: rgb(58, 106, 159);
  font-size: 11px;
  border-radius: 0px;
  padding-top: 2px;
  padding-right: 6px;
}
```

## Component Clusters

Reusable component instances grouped by DOM structure and style similarity:

### Button — 2 instances, 1 variant

**Variant 1** (2 instances)

```css
  background: rgb(38, 37, 30);
  color: rgb(247, 247, 244);
  padding: 5.6px 10.5px 5.88px 10.5px;
  border-radius: 3.35544e+07px;
  border: 1px solid rgb(38, 37, 30);
  font-size: 14px;
  font-weight: 400;
```

### Button — 11 instances, 3 variants

**Variant 1** (3 instances)

```css
  background: rgba(0, 0, 0, 0);
  color: rgb(38, 37, 30);
  padding: 0px 0px 0px 0px;
  border-radius: 0px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 14px;
  font-weight: 400;
```

**Variant 2** (5 instances)

```css
  background: rgba(0, 0, 0, 0);
  color: oklab(0.263084 -0.00230259 0.0124794 / 0.6);
  padding: 5.6px 7.5px 5.6px 7.5px;
  border-radius: 4px;
  border: 0px solid oklab(0.263084 -0.00230259 0.0124794 / 0.6);
  font-size: 13px;
  font-weight: 400;
```

**Variant 3** (3 instances)

```css
  background: rgba(0, 0, 0, 0);
  color: rgb(38, 37, 30);
  padding: 5.6px 10.5px 5.88px 10.5px;
  border-radius: 3.35544e+07px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 14px;
  font-weight: 400;
```

### Card — 3 instances, 1 variant

**Variant 1** (3 instances)

```css
  background: rgb(242, 241, 237);
  color: rgb(38, 37, 30);
  padding: 7.9px 15px 12.8px 15px;
  border-radius: 4px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 14px;
  font-weight: 400;
```

### Button — 1 instance, 1 variant

**Variant 1** (1 instance)

```css
  background: rgba(0, 0, 0, 0);
  color: rgb(38, 37, 30);
  padding: 5.6px 10.5px 5.88px 10.5px;
  border-radius: 3.35544e+07px;
  border: 1px solid oklab(0.263084 -0.00230259 0.0124794 / 0.2);
  font-size: 14px;
  font-weight: 400;
```

### Button — 3 instances, 1 variant

**Variant 1** (3 instances)

```css
  background: rgb(38, 37, 30);
  color: rgb(247, 247, 244);
  padding: 12.48px 21.6px 12.8px 21.6px;
  border-radius: 3.35544e+07px;
  border: 1px solid rgb(38, 37, 30);
  font-size: 16px;
  font-weight: 400;
```

### Card — 8 instances, 2 variants

**Variant 1** (4 instances)

```css
  background: rgba(0, 0, 0, 0);
  color: rgb(38, 37, 30);
  padding: 0px 0px 0px 0px;
  border-radius: 4px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 16px;
  font-weight: 400;
```

**Variant 2** (4 instances)

```css
  background: rgb(242, 241, 237);
  color: rgb(38, 37, 30);
  padding: 17.5px 17.5px 17.5px 17.5px;
  border-radius: 4px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 16px;
  font-weight: 400;
```

### Button — 23 instances, 3 variants

**Variant 1** (9 instances)

```css
  background: rgba(0, 0, 0, 0);
  color: oklab(0.263084 -0.00230259 0.0124794 / 0.6);
  padding: 4px 8px 4px 8px;
  border-radius: 4px;
  border: 0px solid oklab(0.263084 -0.00230259 0.0124794 / 0.6);
  font-size: 12px;
  font-weight: 400;
```

**Variant 2** (12 instances)

```css
  background: rgba(38, 37, 30, 0.06);
  color: rgba(38, 37, 30, 0.55);
  padding: 6px 12px 6px 12px;
  border-radius: 0px;
  border: 0px solid rgba(38, 37, 30, 0.55);
  font-size: 17.28px;
  font-weight: 400;
```

**Variant 3** (2 instances)

```css
  background: rgb(192, 133, 50);
  color: rgb(255, 255, 255);
  padding: 2px 8px 2px 8px;
  border-radius: 4px;
  border: 0px solid rgb(255, 255, 255);
  font-size: 12px;
  font-weight: 500;
```

### Button — 15 instances, 2 variants

**Variant 1** (11 instances)

```css
  background: rgba(0, 0, 0, 0);
  color: oklab(0.263084 -0.00230259 0.0124794 / 0.6);
  padding: 0px 0px 0px 0px;
  border-radius: 4px;
  border: 0px solid oklab(0.263084 -0.00230259 0.0124794 / 0.6);
  font-size: 16px;
  font-weight: 400;
```

**Variant 2** (4 instances)

```css
  background: rgb(225, 224, 219);
  color: oklab(0.263084 -0.00230259 0.0124794 / 0.6);
  padding: 0px 0px 0px 0px;
  border-radius: 3.35544e+07px;
  border: 0px solid oklab(0.263084 -0.00230259 0.0124794 / 0.6);
  font-size: 16px;
  font-weight: 400;
```

### Card — 1 instance, 1 variant

**Variant 1** (1 instance)

```css
  background: rgba(0, 0, 0, 0);
  color: rgb(38, 37, 30);
  padding: 0px 0px 0px 0px;
  border-radius: 0px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 16px;
  font-weight: 400;
```

### Button — 6 instances, 2 variants

**Variant 1** (5 instances)

```css
  background: rgba(0, 0, 0, 0);
  color: rgb(38, 37, 30);
  padding: 10px 12px 10px 14px;
  border-radius: 0px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 12px;
  font-weight: 400;
```

**Variant 2** (1 instance)

```css
  background: rgb(235, 234, 229);
  color: rgb(38, 37, 30);
  padding: 10px 12px 10px 14px;
  border-radius: 0px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 12px;
  font-weight: 400;
```

### Card — 1 instance, 1 variant

**Variant 1** (1 instance)

```css
  background: rgba(0, 0, 0, 0);
  color: rgb(38, 37, 30);
  padding: 0px 12px 0px 8px;
  border-radius: 0px;
  border: 0px 0px 1px solid oklab(0.263084 -0.00230259 0.0124794 / 0.1);
  font-size: 16px;
  font-weight: 400;
```

### Input — 2 instances, 1 variant

**Variant 1** (2 instances)

```css
  background: rgba(0, 0, 0, 0);
  color: rgb(38, 37, 30);
  padding: 8px 8px 6px 8px;
  border-radius: 0px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 13px;
  font-weight: 400;
```

### Button — 3 instances, 1 variant

**Variant 1** (3 instances)

```css
  background: rgb(230, 229, 224);
  color: oklab(0.263084 -0.00230259 0.0124794 / 0.6);
  padding: 3px 8px 3px 8px;
  border-radius: 3.35544e+07px;
  border: 0px solid oklab(0.263084 -0.00230259 0.0124794 / 0.6);
  font-size: 11px;
  font-weight: 400;
```

### Button — 5 instances, 1 variant

**Variant 1** (5 instances)

```css
  background: rgba(0, 0, 0, 0);
  color: oklab(0.263084 -0.00230259 0.0124794 / 0.6);
  padding: 3px 0px 3px 0px;
  border-radius: 8px;
  border: 0px solid oklab(0.263084 -0.00230259 0.0124794 / 0.6);
  font-size: 11px;
  font-weight: 400;
```

### Input — 1 instance, 1 variant

**Variant 1** (1 instance)

```css
  background: rgba(0, 0, 0, 0);
  color: rgb(38, 37, 30);
  padding: 0px 0px 0px 0px;
  border-radius: 0px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 12px;
  font-weight: 400;
```

### Card — 8 instances, 1 variant

**Variant 1** (8 instances)

```css
  background: rgb(242, 241, 237);
  color: rgb(38, 37, 30);
  padding: 0px 7.5px 0px 7.5px;
  border-radius: 4px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 16px;
  font-weight: 400;
```

### Link — 2 instances, 1 variant

**Variant 1** (2 instances)

```css
  background: rgb(242, 241, 237);
  color: rgb(38, 37, 30);
  padding: 17.5px 17.5px 17.5px 17.5px;
  border-radius: 4px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 16px;
  font-weight: 400;
```

### Card — 2 instances, 1 variant

**Variant 1** (2 instances)

```css
  background: rgba(0, 0, 0, 0);
  color: oklab(0.263084 -0.00230259 0.0124794 / 0.9);
  padding: 0px 0px 0px 0px;
  border-radius: 0px;
  border: 0px solid oklab(0.263084 -0.00230259 0.0124794 / 0.9);
  font-size: 14px;
  font-weight: 400;
```

### Card — 2 instances, 1 variant

**Variant 1** (2 instances)

```css
  background: rgb(242, 241, 237);
  color: oklab(0.263084 -0.00230259 0.0124794 / 0.9);
  padding: 0px 8px 0px 12px;
  border-radius: 0px;
  border: 0px 1px 1px 0px solid oklab(0.263084 -0.00230259 0.0124794 / 0.1);
  font-size: 14px;
  font-weight: 400;
```

### Button — 5 instances, 3 variants

**Variant 1** (3 instances)

```css
  background: rgba(0, 0, 0, 0);
  color: oklab(0.263084 -0.00230259 0.0124794 / 0.6);
  padding: 4px 6px 4px 0px;
  border-radius: 4px;
  border: 0px solid oklab(0.263084 -0.00230259 0.0124794 / 0.6);
  font-size: 16px;
  font-weight: 400;
```

**Variant 2** (1 instance)

```css
  background: rgb(235, 234, 229);
  color: rgb(38, 37, 30);
  padding: 5.6px 7.5px 5.6px 7.5px;
  border-radius: 4px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 13px;
  font-weight: 400;
```

**Variant 3** (1 instance)

```css
  background: rgb(230, 229, 224);
  color: rgb(38, 37, 30);
  padding: 5.6px 10.5px 5.88px 10.5px;
  border-radius: 3.35544e+07px;
  border: 1px solid oklab(0.263084 -0.00230259 0.0124794 / 0.025);
  font-size: 14px;
  font-weight: 400;
```

### Card — 3 instances, 1 variant

**Variant 1** (3 instances)

```css
  background: rgb(235, 234, 229);
  color: rgb(38, 37, 30);
  padding: 0px 0px 0px 0px;
  border-radius: 0px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 16px;
  font-weight: 400;
```

### Card — 1 instance, 1 variant

**Variant 1** (1 instance)

```css
  background: rgb(235, 234, 229);
  color: rgb(38, 37, 30);
  padding: 4px 10px 4px 10px;
  border-radius: 8px;
  border: 1px solid color(srgb 0.149019 0.145098 0.117647 / 0.06);
  font-size: 16px;
  font-weight: 400;
```

### Button — 2 instances, 2 variants

**Variant 1** (1 instance)

```css
  background: rgb(235, 234, 229);
  color: rgb(38, 37, 30);
  padding: 6px 6px 6px 6px;
  border-radius: 8px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 16px;
  font-weight: 400;
```

**Variant 2** (1 instance)

```css
  background: rgba(0, 0, 0, 0);
  color: rgb(38, 37, 30);
  padding: 6px 6px 6px 6px;
  border-radius: 8px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 16px;
  font-weight: 400;
```

### Button — 4 instances, 1 variant

**Variant 1** (4 instances)

```css
  background: rgba(0, 0, 0, 0);
  color: rgb(38, 37, 30);
  padding: 6px 6px 6px 6px;
  border-radius: 8px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 16px;
  font-weight: 400;
```

### Card — 6 instances, 2 variants

**Variant 1** (4 instances)

```css
  background: rgb(235, 234, 229);
  color: rgb(38, 37, 30);
  padding: 10px 8px 10px 8px;
  border-radius: 8px;
  border: 1px solid oklab(0.263084 -0.00230259 0.0124794 / 0.1);
  font-size: 16px;
  font-weight: 400;
```

**Variant 2** (2 instances)

```css
  background: rgba(0, 0, 0, 0);
  color: rgb(38, 37, 30);
  padding: 0px 0px 0px 0px;
  border-radius: 4px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 16px;
  font-weight: 400;
```

### Button — 1 instance, 1 variant

**Variant 1** (1 instance)

```css
  background: rgb(230, 229, 224);
  color: oklab(0.263084 -0.00230259 0.0124794 / 0.6);
  padding: 3px 8px 3px 8px;
  border-radius: 3.35544e+07px;
  border: 0px solid oklab(0.263084 -0.00230259 0.0124794 / 0.6);
  font-size: 11px;
  font-weight: 400;
```

### Button — 1 instance, 1 variant

**Variant 1** (1 instance)

```css
  background: rgb(235, 234, 229);
  color: rgb(38, 37, 30);
  padding: 9px 10px 9px 10px;
  border-radius: 4px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 16px;
  font-weight: 400;
```

### Button — 1 instance, 1 variant

**Variant 1** (1 instance)

```css
  background: rgb(38, 37, 30);
  color: rgb(247, 247, 244);
  padding: 5.6px 10.5px 5.88px 10.5px;
  border-radius: 3.35544e+07px;
  border: 1px solid rgb(38, 37, 30);
  font-size: 14px;
  font-weight: 400;
```

### Card — 1 instance, 1 variant

**Variant 1** (1 instance)

```css
  background: rgb(242, 241, 237);
  color: rgb(38, 37, 30);
  padding: 0px 0px 0px 0px;
  border-radius: 12px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 16px;
  font-weight: 400;
```

### Button — 1 instance, 1 variant

**Variant 1** (1 instance)

```css
  background: rgba(0, 0, 0, 0);
  color: rgb(38, 37, 30);
  padding: 4px 0px 4px 0px;
  border-radius: 4px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 14px;
  font-weight: 400;
```

### Card — 4 instances, 1 variant

**Variant 1** (4 instances)

```css
  background: rgba(0, 0, 0, 0);
  color: rgba(0, 0, 0, 0);
  padding: 0px 0px 0px 0px;
  border-radius: 3.35544e+07px;
  border: 1px solid rgb(242, 241, 237);
  font-size: 12px;
  font-weight: 400;
```

### Card — 6 instances, 1 variant

**Variant 1** (6 instances)

```css
  background: rgb(242, 241, 237);
  color: rgb(38, 37, 30);
  padding: 15.9px 17.5px 17.5px 17.5px;
  border-radius: 4px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 16px;
  font-weight: 400;
```

### Card — 3 instances, 1 variant

**Variant 1** (3 instances)

```css
  background: rgb(242, 241, 237);
  color: rgb(38, 37, 30);
  padding: 15.9px 17.5px 17.5px 17.5px;
  border-radius: 4px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 16px;
  font-weight: 400;
```

### Link — 4 instances, 1 variant

**Variant 1** (4 instances)

```css
  background: rgb(242, 241, 237);
  color: rgb(38, 37, 30);
  padding: 15.9px 17.5px 20px 17.5px;
  border-radius: 4px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 16px;
  font-weight: 400;
```

### Link — 4 instances, 1 variant

**Variant 1** (4 instances)

```css
  background: rgb(242, 241, 237);
  color: rgb(38, 37, 30);
  padding: 13.4px 15px 15px 15px;
  border-radius: 4px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 16px;
  font-weight: 400;
```

### Card — 3 instances, 1 variant

**Variant 1** (3 instances)

```css
  background: rgb(230, 229, 224);
  color: rgb(38, 37, 30);
  padding: 0px 0px 0px 0px;
  border-radius: 3.35544e+07px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 16px;
  font-weight: 400;
```

### Card — 2 instances, 1 variant

**Variant 1** (2 instances)

```css
  background: rgb(230, 229, 224);
  color: rgb(38, 37, 30);
  padding: 0px 0px 0px 0px;
  border-radius: 3.35544e+07px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 16px;
  font-weight: 400;
```

### Card — 1 instance, 1 variant

**Variant 1** (1 instance)

```css
  background: rgb(242, 241, 237);
  color: rgb(38, 37, 30);
  padding: 67.2px 20px 30px 20px;
  border-radius: 0px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 16px;
  font-weight: 400;
```

### Card — 1 instance, 1 variant

**Variant 1** (1 instance)

```css
  background: rgb(230, 229, 224);
  color: rgb(38, 37, 30);
  padding: 2px 2px 2px 2px;
  border-radius: 3.35544e+07px;
  border: 0px solid rgb(38, 37, 30);
  font-size: 14px;
  font-weight: 400;
```

## Layout System

**62 grid containers** and **427 flex containers** detected.

### Container Widths

| Max Width | Padding |
|-----------|---------|
| 1300px | 0px |
| 100% | 0px |
| 320px | 0px |
| 398.131px | 0px |
| 580px | 0px |
| 672px | 64px |
| 740px | 0px |
| 658.32px | 0px |
| 810.24px | 0px |

### Grid Column Patterns

| Columns | Usage Count |
|---------|-------------|
| 1-column | 29x |
| 24-column | 10x |
| 2-column | 6x |
| 3-column | 3x |
| 4-column | 2x |
| 8-column | 1x |
| 5-column | 1x |

### Grid Templates

```css
grid-template-columns: 1240px;
grid-template-columns: 1240px;
grid-template-columns: 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px;
gap: 0px 10px;
grid-template-columns: 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px 40.625px;
gap: 0px 10px;
grid-template-columns: 1240px;
```

### Flex Patterns

| Direction/Wrap | Count |
|----------------|-------|
| row/nowrap | 340x |
| column/nowrap | 76x |
| row-reverse/nowrap | 2x |
| row/wrap | 9x |

**Gap values:** `0px 10px`, `1.86667px 3.73333px`, `10px`, `12.8px`, `12px`, `15px`, `16px`, `1px`, `2.5px`, `2px`, `3.5px`, `3px`, `44.8px`, `44.8px 10px`, `4px`, `5.6px 7.46667px`, `5px`, `6px`, `7.5px`, `8px`, `normal 10px`, `normal 12.8px`

## Accessibility (WCAG 2.1)

**Overall Score: 82%** — 9 passing, 2 failing color pairs

### Failing Color Pairs

| Foreground | Background | Ratio | Level | Used On |
|------------|------------|-------|-------|---------|
| `#ffffff` | `#c08532` | 3.16:1 | FAIL | button (2x) |

### Passing Color Pairs

| Foreground | Background | Ratio | Level |
|------------|------------|-------|-------|
| `#f7f7f4` | `#26251e` | 14.33:1 | AAA |
| `#26251e` | `#e6e5e0` | 12.19:1 | AAA |
| `#ffffff` | `#34785c` | 5.27:1 | AA |

## Design System Score

**Overall: 77/100 (Grade: C)**

| Category | Score |
|----------|-------|
| Color Discipline | 92/100 |
| Typography Consistency | 50/100 |
| Spacing System | 70/100 |
| Shadow Consistency | 90/100 |
| Border Radius Consistency | 100/100 |
| Accessibility | 82/100 |
| CSS Tokenization | 100/100 |

**Strengths:** Tight, disciplined color palette, Clean elevation system, Consistent border radii, Good CSS variable tokenization

**Issues:**
- 6 font families — consider limiting to 2 (heading + body)
- 2 WCAG contrast failures
- 187 !important rules — prefer specificity over overrides
- 5273 duplicate CSS declarations

## Gradients

**5 unique gradients** detected.

| Type | Direction | Stops | Classification |
|------|-----------|-------|----------------|
| linear | — | 2 | brand |
| linear | — | 2 | brand |
| linear | — | 3 | bold |
| linear | to top in oklab | 2 | brand |
| linear | 90deg | 5 | complex |

```css
background: linear-gradient(oklab(0.263084 -0.00230259 0.0124794 / 0.05) 0%, oklab(0.263084 -0.00230259 0.0124794 / 0.05) 100%);
background: linear-gradient(rgb(242, 241, 237) 0%, rgb(242, 241, 237) 100%);
background: linear-gradient(in oklab, rgb(242, 241, 237) 0%, rgba(0, 0, 0, 0) 100%);
background: linear-gradient(to top in oklab, rgb(242, 241, 237) 0%, rgba(0, 0, 0, 0) 100%);
background: linear-gradient(90deg, oklab(0.263084 -0.00230259 0.0124794 / 0.6) 0%, oklab(0.263084 -0.00230259 0.0124794 / 0.6) 30%, color(srgb 0.14902 0.145098 0.117647 / 0.92) 55%, oklab(0.263084 -0.00230259 0.0124794 / 0.6) 70%, oklab(0.263084 -0.00230259 0.0124794 / 0.6) 100%);
```

## Z-Index Map

**9 unique z-index values** across 2 layers.

| Layer | Range | Elements |
|-------|-------|----------|
| sticky | 10,51 | div.a.b.s.o.l.u.t.e. .t.o.p.-.0. .r.i.g.h.t.-.0. .b.o.t.t.o.m.-.0. .l.e.f.t.-.0. .z.-.1.0. .h.-.f.u.l.l. .w.-.f.u.l.l, div.g.r.o.u.p. .a.b.s.o.l.u.t.e. .r.o.u.n.d.e.d.-.[.1.0.p.x.]. .o.v.e.r.f.l.o.w.-.h.i.d.d.e.n. .f.l.e.x. .f.l.e.x.-.c.o.l. .b.g.-.t.h.e.m.e.-.p.r.o.d.u.c.t.-.c.h.r.o.m.e. .s.e.l.e.c.t.-.n.o.n.e, div.s.t.i.c.k.y. .t.o.p.-.0. .z.-.1.0 |
| base | 0,2 | div.m.e.d.i.a.-.l.i.g.h.t. .a.b.s.o.l.u.t.e. .i.n.s.e.t.-.0. .z.-.0, div.m.e.d.i.a.-.d.a.r.k. .a.b.s.o.l.u.t.e. .i.n.s.e.t.-.0. .z.-.0, div.m.e.d.i.a.-.l.i.g.h.t. .a.b.s.o.l.u.t.e. .i.n.s.e.t.-.0. .z.-.0 |

## SVG Icons

**29 unique SVG icons** detected. Dominant style: **filled**.

| Size Class | Count |
|------------|-------|
| xs | 15 |
| sm | 4 |
| md | 1 |
| xl | 9 |

**Icon colors:** `currentColor`

## Font Files

| Family | Source | Weights | Styles |
|--------|--------|---------|--------|
| KaTeX_AMS | self-hosted | 400 | normal |
| KaTeX_Caligraphic | self-hosted | 400, 700 | normal |
| KaTeX_Fraktur | self-hosted | 400, 700 | normal |
| KaTeX_Main | self-hosted | 400, 700 | normal, italic |
| KaTeX_Math | self-hosted | 400, 700 | italic |
| KaTeX_SansSerif | self-hosted | 400, 700 | normal, italic |
| KaTeX_Script | self-hosted | 400 | normal |
| KaTeX_Size1 | self-hosted | 400 | normal |
| KaTeX_Size2 | self-hosted | 400 | normal |
| KaTeX_Size3 | self-hosted | 400 | normal |
| KaTeX_Size4 | self-hosted | 400 | normal |
| KaTeX_Typewriter | self-hosted | 400 | normal |
| CursorGothic | self-hosted | 400, 700 | normal, italic |
| berkeleyMono | self-hosted | 400 | normal, italic |
| EB Garamond | self-hosted | 400, 500, 600, 700, 800 | italic, normal |
| Lato | self-hosted | 100, 300, 400, 700, 900 | italic, normal |
| CursorIcons16 | self-hosted | normal | normal |

## Image Style Patterns

| Pattern | Count | Key Styles |
|---------|-------|------------|
| thumbnail | 14 | objectFit: cover, borderRadius: 4px, shape: rounded |
| hero | 6 | objectFit: cover, borderRadius: 0px, shape: square |
| avatar | 4 | objectFit: cover, borderRadius: 3.35544e+07px, shape: circular |
| general | 3 | objectFit: cover, borderRadius: 0px, shape: square |

**Aspect ratios:** 1:1 (19x), 4:3 (4x), 16:9 (3x), 3:2 (1x)

## Motion Language

**Feel:** mixed · **Scroll-linked:** yes

### Duration Tokens

| name | value | ms |
|---|---|---|
| `xs` | `140ms` | 140 |
| `sm` | `200ms` | 200 |
| `lg` | `500ms` | 500 |

### Easing Families

- **custom** (81 uses) — `cubic-bezier(0.4, 0, 0.2, 1)`
- **ease-out** (13 uses) — `cubic-bezier(0.25, 1, 0.5, 1)`, `cubic-bezier(0, 0, 0.2, 1)`
- **linear** (3 uses) — `linear`

### Keyframes In Use

| name | kind | properties | uses |
|---|---|---|---|
| `tabCaretBlink` | fade | opacity | 1 |

## Component Anatomy

### button — 84 instances

**Slots:** label
**Variants:** ghost · primary · secondary
**Sizes:** sm · xs · medium · md · lg

| variant | count | sample label |
|---|---|---|
| default | 80 | Skip to content |
| secondary | 2 | Request a demo
→ |
| ghost | 1 | Contact sales |
| primary | 1 | Download |

### card — 56 instances

**Sizes:** sm · large · md · lg · xl

### link — 10 instances

**Sizes:** large

### input — 3 instances

**Variants:** outline

## Brand Voice

**Tone:** neutral · **Pronoun:** you-only · **Headings:** Sentence case (tight)

### Top CTA Verbs

- **get** (6)
- **composer** (4)
- **may** (4)
- **download** (3)
- **agent** (3)
- **read** (3)
- **skip** (2)
- **plan** (2)

### Button Copy Patterns

- "composer 2.5" (4×)
- "get cursor" (3×)
- "agent" (3×)
- "↓" (2×)
- "download for macos
⤓" (2×)
- "get cli" (2×)
- "opus 4.7" (2×)
- "skip to content" (1×)
- "contact sales" (1×)
- "download" (1×)

### Sample Headings

> Built to make you extraordinarily productive, Cursor is the best coding agent.
> Trusted every day by teams that build world-class software
> Agents turn ideas into code
> Mission Control Interface
> Trigger
> Built to make you extraordinarily productive, Cursor is the best coding agent.
> Trusted every day by teams that build world-class software
> Agents turn ideas into code
> Mission Control Interface
> Trigger

## Page Intent

**Type:** `landing` (confidence 0.31)
**Description:** Built to make you extraordinarily productive, Cursor is the best coding agent.

Alternates: blog-post (0.35)

## Section Roles

Reading order (top→bottom): cta → nav → nav → nav → content → comparison → comparison → comparison → nav → content → feature-grid → feature-grid → feature-grid → feature-grid → testimonial → testimonial → content → content → content → content → hero → footer → nav

| # | Role | Heading | Confidence |
|---|------|---------|------------|
| 0 | content | — | 0.3 |
| 1 | cta | — | 0.75 |
| 2 | nav | — | 0.9 |
| 3 | nav | — | 0.9 |
| 4 | nav | — | 0.4 |
| 5 | comparison | Built to make you extraordinarily productive, Cursor is the best coding agent. | 0.7 |
| 6 | comparison | Built to make you extraordinarily productive, Cursor is the best coding agent. | 0.7 |
| 7 | comparison | — | 0.7 |
| 8 | nav | — | 0.4 |
| 9 | content | Trusted every day by teams that build world-class software | 0.3 |
| 10 | feature-grid | Agents turn ideas into code | 0.8 |
| 11 | feature-grid | Agents turn ideas into code | 0.8 |
| 12 | feature-grid | Works autonomously, runs in parallel | 0.8 |
| 13 | feature-grid | In every tool, at every step | 0.8 |
| 14 | testimonial | Magically accurate autocomplete | 0.8 |
| 15 | testimonial | The new way to build software. | 0.8 |
| 16 | content | Stay on the frontier | 0.3 |
| 17 | content | Changelog | 0.3 |
| 18 | content | Cursor is an applied research team focused on building the future of software de | 0.3 |
| 19 | content | Recent highlights | 0.3 |

## Material Language

**Label:** `flat` (confidence 0)

| Metric | Value |
|--------|-------|
| Avg saturation | 0.425 |
| Shadow profile | soft |
| Avg shadow blur | 0px |
| Max radius | 12px |
| backdrop-filter in use | no |
| Gradients | 5 |

## Imagery Style

**Label:** `gradient-mesh` (confidence 1)
**Counts:** total 27, svg 0, icon 12, screenshot-like 0, photo-like 2
**Dominant aspect:** square-ish
**Radius profile on images:** full

## Component Library

**Detected:** `tailwindcss` (confidence 0.765)

Evidence:
- tailwind-like class density 74%

## Quick Start

To recreate this design in a new project:

1. **Install fonts:** Add `CursorGothic` from Google Fonts or your font provider
2. **Import CSS variables:** Copy `variables.css` into your project
3. **Tailwind users:** Use the generated `tailwind.config.js` to extend your theme
4. **Design tokens:** Import `design-tokens.json` for tooling integration
