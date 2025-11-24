# Dashboard UI/UX Redesign Task List

## Phase 1: Layout Restructuring
- [x] Create new layout structure ("Holy Grail" pattern)
  - [x] Implement slim left sidebar with screened token list
  - [x] Create top header with global state (Account Value, PnL, Network, Wallet)
  - [x] Define center workspace area for chart and market data
  - [x] Define right panel for execution and controls
  - [x] Define bottom drawer for data tables
- [x] Update main page layout (`app/page.tsx`)
- [x] Create navigation component for left sidebar
  - [x] Replace icons with screened token names
  - [x] Add filter button as first item
  - [x] Add hover popover for market data preview

## Phase 2: Component Reorganization
- [x] Screening Parameters
  - [x] Convert to collapsible filter drawer/modal
  - [x] Add "Filter" button trigger in left navigation
  - [x] Implement slide-out drawer functionality
  - [x] Remove redundant filter button from HyperliquidFeed
- [ ] Chart Component
  - [x] Expand to occupy top 60% of center workspace
  - [ ] Move timeframe controls inside chart area (overlay)
  - [ ] Move indicator toggles inside chart area (overlay)
- [x] Execution & AI Agent
  - [x] Create unified tabbed action panel
  - [x] Implement Manual tab (Long/Short, Size, Leverage)
  - [x] Implement AI Agent tab (Emergency Stop, Frequency, Model)
  - [x] Position in right sidebar
  - [x] Optimize TradeForm for tab display
  - [x] Update tab styling to underline style (less button-like)
- [x] Backtester
  - [x] Move to separate page/route
  - [x] Add navigation link in left sidebar
  - [x] Remove from main dashboard view
- [x] Portfolio & Positions
  - [x] Convert position cards to data table
  - [x] Position at bottom of screen (below chart)
  - [x] Add columns: Asset, Side, Size, Entry, Mark, PnL, ROE, Close

## Phase 3: Visual & UI Polish
- [x] Color System
  - [x] Ensure green/red only for data (profit/loss)
  - [x] Maintain dark theme consistency
- [x] Typography
  - [x] Make Price and PnL largest fonts (in header)
  - [x] Reduce label opacity to 60% grey (in TradeForm)
- [x] Spacing & Layout
  - [x] Optimize screen real estate
  - [x] Reduce visual clutter
  - [x] Improve component spacing
  - [x] Remove redundant Testnet badge
  - [x] Fix scrollbar appearance in right sidebar
  - [x] Update tab styling to underline style
- [x] Left Navigation
  - [x] Replace navigation icons with screened token symbols
  - [x] Add hover popover showing price, 24h change, and volume
  - [x] Filter button as first item
  - [x] Active token highlighting

## Phase 4: Verification
- [x] Test responsive behavior on different screen sizes
- [x] Verify all components render correctly in new layout
- [ ] Test navigation between dashboard and backtester
- [x] Verify filter drawer functionality
- [x] Test tabbed execution panel switching
- [x] Verify data table displays positions correctly
- [x] Test token selection from left navigation
- [x] Verify hover popover displays market data
- [ ] Test overall user workflow and accessibility
