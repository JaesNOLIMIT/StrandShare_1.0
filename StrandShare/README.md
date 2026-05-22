# Donivra - Hair Donation Platform

A modern, pixel-perfect React frontend for the Donivra hair donation platform. Built with React, Tailwind CSS, Lucide React icons, and Recharts for analytics.

## Features

- **Pixel-Perfect Design**: Two complete screens - Login page and Super Admin Dashboard
- **White-Label Ready**: Customize the entire app's branding by changing a single primary color variable
- **Dark Mode Support**: Full dark mode support using Tailwind's dark mode classes
- **Responsive Layout**: Desktop-optimized layouts with responsive design principles
- **Real-time Charts**: Interactive system performance and traffic visualizations using Recharts
- **Production-Ready Code**: Complete, no placeholders, ready for deployment
- **High-Quality Images**: Uses Unsplash URLs for professional-grade image placeholders

## Project Structure

```
src/
├── pages/
│   ├── LoginPage.jsx          # 50/50 split-screen login interface
│   └── AdminDashboard.jsx     # Super Admin dashboard landing page
├── components/
│   ├── Sidebar.jsx            # Navigation sidebar with system status card
│   ├── Header.jsx             # Top header with search and profile
│   ├── SystemHealthOverview.jsx # Main dashboard content
│   ├── KPICards.jsx           # Key performance indicator cards (4-column grid)
│   ├── Charts.jsx             # System performance and traffic charts
│   ├── DatabaseHealth.jsx     # Database health log list
│   └── QuickActions.jsx       # Quick action buttons grid
├── App.jsx                    # Main app component with routing
├── index.js                   # React entry point
└── index.css                  # Global styles with CSS variables

public/
└── index.html                 # Main HTML template

Configuration Files:
├── package.json               # Dependencies and scripts
├── tailwind.config.js         # Tailwind configuration with color variables
├── postcss.config.js          # PostCSS configuration
└── .gitignore                 # Git ignore rules

```

## Getting Started

### Installation

1. Navigate to the project directory:
```bash
cd Donivra
```

2. Install dependencies:
```bash
npm install
```

3. Start the development server:
```bash
npm start
```

The app will open at `http://localhost:3000`

## Customization

### Primary Color (White-Label)

The entire app's branding is controlled by CSS variables. To change the primary color from the default blue (#0275d8) to your brand color:

1. Open `src/index.css`
2. Update the `--color-primary` variable in the `:root` selector:

```css
:root {
  --color-primary: #YOUR_HEX_COLOR;
  --color-primary-dark: #DARKER_SHADE;
  --color-primary-light: #LIGHTER_SHADE;
}
```

All buttons, links, accents, and brand elements will automatically update.

### Dark Mode

Dark mode is automatically supported throughout the app using Tailwind's `dark:` prefix classes. To toggle dark mode:

1. Add the `dark` class to the `<html>` element:
```javascript
document.documentElement.classList.add('dark');
document.documentElement.classList.remove('dark'); // to toggle off
```

2. Or implement a theme toggle component that manages the class dynamically.

### Image Placeholders

The app uses high-quality Unsplash images. To update them:

**Login Page:**
- Salon image: In `src/pages/LoginPage.jsx`, update the `src` URL in the image tag
- Admin avatar: In `src/components/Header.jsx`, update the profile image URL

### Navigation & Routing

The app currently supports two main views:
- **Login Page**: User authentication interface
- **Admin Dashboard**: System health and monitoring dashboard

To add more pages:
1. Create a new component in `src/pages/`
2. Add a new condition in `App.jsx`
3. Use `onNavigate('page-name')` to switch between pages

## Tech Stack

- **React 18**: UI library
- **Tailwind CSS 3**: Utility-first CSS framework with dark mode support
- **Lucide React**: Beautiful, consistent icon library
- **Recharts**: React charting library for data visualization
- **React Scripts**: Create React App build tooling

## Available Scripts

```bash
# Start development server
npm start

# Build for production
npm build

# Run tests
npm test

# Eject configuration (one-way operation)
npm eject
```

## Browser Support

- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)

## Key Features Breakdown

### Login Page
- **50/50 Split Layout**: Visual branding on left, form on right
- **Gradient Background**: Soft pastel gradient on branding side
- **Social Login**: Google and Facebook SSO buttons
- **Form Validation**: Email and password fields with icons
- **Remember Me**: 30-day session persistence checkbox
- **Password Recovery**: "Forgot password?" link
- **Responsive Design**: Adapts to mobile screens

### Admin Dashboard
- **Persistent Sidebar**: Navigation menu with system status indicator
- **Header Bar**: Search, notifications, and profile section
- **KPI Cards**: 4-column grid showing key metrics
- **Performance Charts**: Two smooth area charts using Recharts
- **Database Health**: Status log with timestamps
- **Quick Actions**: 2x2 grid of common admin actions
- **Dark Mode**: Complete dark mode support

## Color Palette

- **Primary Blue**: #0275d8 (customizable via CSS variable)
- **Success Green**: #10b981
- **Warning Orange**: #f97316
- **Error Red**: #ef4444
- **Neutral Gray**: #6b7280 and shades

## Performance Optimizations

- Component lazy loading ready
- Optimized re-renders
- CSS-in-JS free (pure Tailwind)
- No unnecessary dependencies
- Fast chart rendering with Recharts

## Accessibility

- Semantic HTML structure
- ARIA labels for icons
- Keyboard navigation support
- Color contrast ratios meet WCAG standards
- Focus states on all interactive elements

## Future Enhancements

- Add authentication logic
- Implement real API integration
- Add more dashboard pages
- Implement user preferences/settings
- Add notification system
- Implement form validation with error messaging
- Add loading states and skeleton screens

## License

© 2024 Donivra. Built with love for the hair donation community.

## Support

For issues or questions, please refer to the project documentation or contact the development team.


c:\Adrian\Caspstone Project\Donivra\Web_Donivra_1.0\Donivra\
