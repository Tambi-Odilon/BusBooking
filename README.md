# Soatrans — Bus Booking App (Angular 20)

A full-featured bus booking application for Madagascar, built with **Angular 20** using modern standalone components, signals, and lazy-loaded routes.

## ✨ Features

- 🔍 **Search** — Find buses by route, date, and passenger count
- 🚌 **Bus Listing** — Filter by price or travel time, see amenities & ratings
- 💺 **Seat Selection** — Interactive seat map with real-time availability
- 👤 **Passenger Details** — Multi-passenger form with validation
- 💳 **Payment** — Card, UPI, Net Banking, and Mobile Money (MVola, Orange Money, Airtel Money)
- ✅ **Confirmation** — E-ticket with booking reference

## 🛠 Tech Stack

| Technology | Version | Usage |
|-----------|---------|-------|
| **Angular** | 20 | Framework |
| **TypeScript** | 5.8 | Language |
| **Angular Signals** | Built-in | Reactive state management |
| **Angular Router** | Built-in | Lazy-loaded standalone routes |
| **Tailwind CSS** | 3.4 | Utility-first styling |
| **DM Sans** | Google Fonts | Body typography |
| **Fraunces** | Google Fonts | Display typography |

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- npm 9+

### Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd soatrans-angular

# Install dependencies
npm install

# Start development server
npm start
```

Visit `http://localhost:4200`

### Build for Production

```bash
npm run build
```

Output will be in `dist/soatrans-angular/`.

## 📁 Project Structure

```
src/
├── app/
│   ├── components/
│   │   ├── layout/          # App shell with header/footer
│   │   ├── search/          # Search form + popular routes
│   │   ├── bus-list/        # Bus results with filtering
│   │   ├── seat-selection/  # Interactive seat map
│   │   ├── passenger-details/ # Passenger info forms
│   │   ├── payment/         # Payment method selection
│   │   └── confirmation/    # Booking confirmation & e-ticket
│   ├── models/
│   │   └── booking.models.ts  # TypeScript interfaces & mock data
│   ├── services/
│   │   └── booking.service.ts # Signal-based state management
│   ├── app.component.ts     # Root component
│   ├── app.config.ts        # Application configuration
│   └── app.routes.ts        # Lazy-loaded routes
├── styles/
│   └── styles.scss          # Global styles with Tailwind
└── index.html
```

## 🏗 Angular 20 Features Used

- **Standalone Components** — No NgModules, all components are self-contained
- **Signals** — `signal()`, `computed()`, and `effect()` for reactive state
- **Control Flow** — `@if`, `@for`, `@switch` template syntax
- **Lazy Loading** — All routes load components asynchronously
- **`inject()` function** — Functional dependency injection
- **`withComponentInputBinding()`** — Route param binding to component inputs

## 🎨 Design

The app uses a clean, professional aesthetic with:
- **Fraunces** serif for headings (editorial feel)
- **DM Sans** for body text (modern, readable)
- Blue primary palette with thoughtful use of slate neutrals
- Card-based layouts with subtle shadows
- Smooth hover and focus transitions

## 📱 Responsive

Fully responsive across mobile, tablet, and desktop using Tailwind's responsive breakpoints.

---

Converted from the original React/Vite implementation to Angular 20 with standalone architecture.
