---
name: DipDaemon
description: Restrained dark workspace for paper trading and automation
colors:
  bg: "#0b0e11"
  surface: "#11161b"
  raised: "#171e25"
  border: "#29333d"
  text: "#e7edf3"
  muted: "#a2b0bf"
  green: "#8ce7b2"
  red: "#ff9098"
  amber: "#f2cf8d"
  blue: "#9ac6f6"
  positive-surface: "#14271e"
  negative-surface: "#2b1a20"
  info-surface: "#151f2a"
  field-bg: "#0c1116"
typography:
  headline:
    fontFamily: '"Segoe UI", system-ui, -apple-system, sans-serif'
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: '"Segoe UI", system-ui, -apple-system, sans-serif'
    fontSize: "17px"
    fontWeight: 600
    letterSpacing: "-0.01em"
  body:
    fontFamily: '"Segoe UI", system-ui, -apple-system, sans-serif'
    fontSize: "14px"
    lineHeight: 1.55
  label:
    fontSize: "12px"
  number:
    fontFamily: '"Cascadia Code", "Consolas", monospace'
    fontSize: "12px"
rounded:
  badge: "5px"
  field: "6px"
  button: "7px"
  navigation: "8px"
  panel: "12px"
  dialog: "14px"
spacing:
  compact: "8px"
  medium: "16px"
  panel: "22px"
  section: "28px"
components:
  button-primary:
    backgroundColor: "{colors.green}"
    textColor: "#0c2014"
    rounded: "{rounded.button}"
    padding: "10px 15px"
  button-secondary:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.button}"
    padding: "10px 15px"
  button-danger:
    backgroundColor: "#351c24"
    textColor: "#ffc2c7"
    rounded: "{rounded.button}"
    padding: "10px 15px"
  button-text:
    textColor: "{colors.green}"
    padding: "10px 0"
  input:
    backgroundColor: "{colors.field-bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    padding: "10px 12px"
  navigation:
    textColor: "{colors.muted}"
    rounded: "{rounded.navigation}"
    padding: "11px 14px"
  badge:
    rounded: "{rounded.badge}"
    padding: "4px 8px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
---

# Design System: DipDaemon

## Overview

**Creative North Star: "Restrained trading workspace"**

The inherited dark and green interface is a restrained operating workspace. Dense financial information, explicit execution state and readable controls take priority over decoration.

Opaque surfaces and thin boundaries organize the account, research and automation tools. Installed sans-serif UI and monospace financial values require no external font request.

**Key Characteristics:**
- Restrained dark surfaces with green action identity.
- Dense real tables and tabular financial numerals.
- Explicit PAPER, synthetic-data and risk state.

## Colors

Dark charcoal neutrals carry information; soft green identifies actions and positive state.

### Primary
- **Action Green:** Primary controls, active navigation, focus, positive values and chart marks.

### Secondary
- **Warning Amber:** Paper mode, pending decisions and caution notices.
- **Danger Rose:** Negative results, rejection and failure state.
- **Information Blue:** Synthetic-data identity and informational notices.

### Neutral
- **Canvas, Surface and Raised:** Page ground, persistent navigation/panels and secondary controls.
- **Foreground and Muted:** Primary information and supporting text.
- **Border:** Thin divisions between operational regions.

**The State Has Words Rule.** Pair semantic color with status text, signed values or explicit labels.

## Typography

**Body Font:** Segoe UI with system sans-serif fallbacks.
**Label/Mono Font:** Cascadia Code with Consolas and monospace fallbacks for financial cells.

**Character:** Quiet installed UI typography with compact labels and steady numeric alignment. There is no decorative display face.

### Hierarchy
- **Headline:** Page headings use the headline token; phone headings reduce to (25px).
- **Title:** Panel headings use the title token; smaller subheadings use (14px).
- **Body:** Base body uses the body token; supporting operational content commonly uses (12px). Paragraphs cap at (74ch).
- **Label:** Functional labels and table copy use (11–12px); state badges use (11px), weight (650), tracking (0.06em) and uppercase.
- **Number:** Table amounts use the number token with tabular numerals. Summary figures use sans-serif tabular numerals at (23px), with the first metric (29px).

**The Numeric Truth Rule.** Show paise as INR with two decimals; preserve unavailable values as an em dash rather than zero.

## Layout

Desktop navigation is fixed at (222px), shrinking to (190px) at (1150px). The main region caps at (1600px), with desktop padding (30px 36px). Panels and grids share a (22px) gap. Main grids use a wide working column and narrower supporting column; at (920px) they stack, with the trading ticket first. At (1300px) and wider, the ticket is sticky and (345px) wide.

At (650px), navigation becomes a horizontally scrolling row, main padding becomes (24px 18px), and panels use (18px) body padding. Tables retain their structure inside local horizontal scroll containers. The account band moves from five columns to three at (920px), then two on phones with the lead metric spanning both.

## Elevation & Depth

The interface has no surface shadows. Opaque tonal layers and single-pixel boundaries establish depth. The native confirmation dialog uses a translucent black backdrop; focus uses a green outline (2px) offset (4px).

**The Flat Surface Rule.** Use opaque tonal surfaces and thin borders to establish hierarchy.

## Shapes

Panels are softly rounded, controls more compact, and status badges tighter still. Use the recorded radius roles rather than one shared corner size. Borders are generally (1px). Small circular status and legend marks are functional chart/state markers.

## Components

### Buttons
Compact, text-led actions. Primary, secondary, danger and text variants use the recorded assignments. Standard buttons have minimum height (42px); small desktop actions use (34px) and become (44px) on phones. Text actions use (44px). Disabled buttons use opacity (0.48) and a not-allowed cursor. Enabled buttons brighten on hover (1.12); keyboard focus remains visible. Color changes transition over (0.13s ease) only when reduced motion is not requested.

### Chips
Status badges are compact uppercase text with a thin border and role-specific foreground/background. PAPER/pending use amber, synthetic data uses blue, filled/ordered/completed/buy use green, and rejected/failed/sell use rose. Status remains textual.

### Cards / Containers
Panels use the surface color, panel radius, thin border and clipped corners. Headers use padding (20px 22px), bodies (22px), and a dividing line. Tables use compact headers, row separators and a subtle tonal row hover.

### Inputs / Fields
Opaque dark fields use the field radius, a muted stroke and minimum height (44px). Labels remain explicit; supporting copy is muted. The same green focus outline applies to fields and selects. Inline desktop limit modification fields use a compact (34px) minimum height.

### Navigation
Muted sans-serif links become foreground on a raised hover surface. The current page uses green text over a dark green fill and retains aria-current. Desktop links have minimum height (44px); phone navigation scrolls horizontally.

### Financial values and confirmations
Financial cells remain unbroken and tabular. Signed results carry both sign and semantic tone. Material execution changes use the native dialog with explicit action copy; supplementary decision details expand inline. Empty, loading, failure and stale states use direct operational text.

## Do's and Don'ts

### Do:
- **Do** keep keyboard focus visible with the green outline.
- **Do** contain wide tables in their own horizontal scroll area.
- **Do** distinguish paper execution and synthetic data with explicit labels.

### Don't:
- **Don't** add CRT overlays, glow or gradients to the operating interface.
- **Don't** imply a positive result using color alone.
- **Don't** replace unknown financial values with zero.
