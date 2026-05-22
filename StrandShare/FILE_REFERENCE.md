# Donivra Frontend - File Reference Guide

## 📁 Project Structure & File Purposes

### Root Configuration Files

| File | Purpose |
|------|---------|
| `package.json` | Dependencies, scripts, project metadata |
| `tailwind.config.js` | Tailwind CSS configuration with color variables |
| `postcss.config.js` | PostCSS configuration for Tailwind processing |
| `.gitignore` | Git ignore patterns |
| `.env.example` | Environment variable template |

### Documentation Files

| File | Purpose |
|------|---------|
| `README.md` | Project overview, features, getting started |
| `SETUP_GUIDE.md` | Step-by-step customization and setup guide |
| `IMPLEMENTATION_SUMMARY.md` | What was built and how to use it |
| `FILE_REFERENCE.md` | This file - quick reference |

### Public Assets

| File | Purpose |
|------|---------|
| `public/index.html` | Main HTML template with manifest link |
| `public/manifest.json` | PWA manifest for installable app |

### Source Code

#### Main Application Files
| File | Purpose | Key Components |
|------|---------|-----------------|
| `src/index.js` | React entry point | ReactDOM.createRoot() |
| `src/index.css` | Global styles + CSS variables | Color theme variables, dark mode setup |
| `src/App.jsx` | Main app component | Page routing, state management |

#### Page Components
| File | Purpose | Description |
|------|---------|-------------|
| `src/pages/LoginPage.jsx` | Authentication screen | 50/50 split layout, form, branding |
| `src/pages/AdminDashboard.jsx` | Dashboard wrapper | Orchestrates sidebar, header, content |

#### Component Files
| File | Purpose | Contains | Key Features |
|------|---------|----------|--------------|
| `src/components/Sidebar.jsx` | Navigation menu | Nav links, logo, system status card | Active states, icon styling |
| `src/components/Header.jsx` | Top app bar | Search, notifications, profile | Icon indicators, user info |
| `src/components/SystemHealthOverview.jsx` | Main content wrapper | Section header, action buttons | Layout coordinator |
| `src/components/KPICards.jsx` | Metric cards | 4 KPI cards in grid | Trending indicators, icons |
| `src/components/Charts.jsx` | Data visualizations | 2 area charts | Recharts, gradients, tooltips |
| `src/components/DatabaseHealth.jsx` | Status log | 3 status items | Status icons, timestamps |
| `src/components/QuickActions.jsx` | Action buttons | 2x2 button grid | Icon buttons, hover states |

---

## 🎨 Customization Locations

### Colors & Branding
- **Primary Color**: `src/index.css` (line ~2, `--color-primary`)
- **Dark Mode Colors**: `src/index.css` (dark media query)
- **Tailwind Theme**: `tailwind.config.js`

### Text & Copy
- **Login Page**: `src/pages/LoginPage.jsx` (lines 30-150)
- **Dashboard Header**: `src/components/Header.jsx` (line 11)
- **Navigation**: `src/components/Sidebar.jsx` (lines 5-12)
- **KPI Labels**: `src/components/KPICards.jsx` (lines 6-18)
- **Chart Labels**: `src/components/Charts.jsx` (lines 20, 38)
- **Database Items**: `src/components/DatabaseHealth.jsx` (lines 6-22)

### Images
- **Login Banner**: `src/pages/LoginPage.jsx` (line 48)
- **Admin Avatar**: `src/components/Header.jsx` (line 68)
- **Logo Icon**: `src/components/Sidebar.jsx` (line 29)

### Icons
- **All icons**: Lucide React from `lucide-react` package
- **Icon selection**: See individual component files
- **Change icons**: Update import statement and component

---

## 📊 Data Sources & Mock Data

### Chart Data
**File**: `src/components/Charts.jsx`
- `performanceData` - System Performance Index chart (lines 12-19)
- `trafficData` - Peak User Traffic chart (lines 21-28)

### KPI Values
**File**: `src/components/KPICards.jsx`
- `kpiData` - Array of 4 KPI cards (lines 6-18)

### Database Health Items
**File**: `src/components/DatabaseHealth.jsx`
- `healthItems` - Array of 3 status items (lines 6-22)

### Navigation Items
**File**: `src/components/Sidebar.jsx`
- `navItems` - Array of 6 navigation links (lines 6-12)

---

## 🔧 Configuration Files Explained

### tailwind.config.js
```javascript
// Enables CSS variable colors
colors: {
  primary: 'var(--color-primary)',
  ...
}

// Enables dark mode class support
darkMode: 'class'
```

### src/index.css
```css
:root {
  --color-primary: #0275d8;        /* Main brand color */
  --color-primary-dark: #025aa3;   /* Dark hover state */
  --color-primary-light: #0a8ef5;  /* Light accents */
}

@media (prefers-color-scheme: dark) {
  :root {
    /* Dark mode color overrides */
  }
}
```

---

## 🚀 Build & Deployment

### Development
```bash
npm install          # Install dependencies
npm start            # Start dev server (http://localhost:3000)
```

### Production
```bash
npm run build        # Create optimized build
npm test             # Run tests (if configured)
```

### Deployment Commands
```bash
# For Netlify
npm run build
# Publish the 'build' folder

# For Vercel
# Auto-detected configuration from package.json

# For other hosts
npm run build
# Upload contents of 'build' folder to static hosting
```

---

## 📦 Dependencies & Versions

| Package | Version | Purpose |
|---------|---------|---------|
| react | 18.2.0 | UI library |
| react-dom | 18.2.0 | React rendering |
| react-scripts | 5.0.1 | Build tools |
| tailwindcss | 3.3.0 | CSS framework |
| postcss | 8.4.24 | CSS processing |
| autoprefixer | 10.4.14 | Vendor prefixes |
| lucide-react | 0.263.1 | Icon library |
| recharts | 2.8.0 | Charting library |
| react-icons | 4.11.0 | Additional icons |

---

## 🎯 Component Props & Features

### LoginPage
```jsx
<LoginPage onNavigate={setCurrentPage} />
// Props: onNavigate(pageName) - callback to switch pages
// Features: Split layout, form validation, SSO buttons
```

### AdminDashboard
```jsx
<AdminDashboard onNavigate={setCurrentPage} />
// Props: onNavigate(pageName) - callback to switch pages
// Features: Full dashboard layout with all sections
```

### Other Components
All components are self-contained and use local state for features like:
- Navigation active state (Sidebar)
- Form input states (LoginPage)
- Theme management ready for context API

---

## 🎨 Dark Mode Implementation

### How It Works
1. Add `dark` class to `<html>` element
2. Tailwind prefixes with `dark:` automatically apply
3. CSS variables in dark media query provide theme adjustments

### Testing Dark Mode
```javascript
// In browser console
document.documentElement.classList.add('dark');         // Enable
document.documentElement.classList.remove('dark');      // Disable
```

### Implementing Toggle
Create a theme context or use localStorage:
```javascript
const [isDark, setIsDark] = useState(false);

useEffect(() => {
  isDark 
    ? document.documentElement.classList.add('dark')
    : document.documentElement.classList.remove('dark');
}, [isDark]);
```

---

## 📈 Performance Optimizations

- **Component Structure**: Proper separation of concerns
- **CSS-in-JS Free**: Pure Tailwind for smaller bundle
- **Icon System**: Lucide React tree-shakeable icons
- **Chart Optimization**: Recharts lazy loading ready
- **Responsive Design**: Mobile-ready foundation

---

## 🔍 Troubleshooting Guide

| Issue | File | Solution |
|-------|------|----------|
| Colors not changing | `src/index.css` | Update CSS variable value |
| Dark mode not working | `tailwind.config.js` | Verify `darkMode: 'class'` is set |
| Icons not showing | Component files | Check Lucide import statement |
| Images missing | Component files | Verify Unsplash URL is valid |
| Charts not rendering | `src/components/Charts.jsx` | Check ResponsiveContainer has height |
| Form not working | `src/pages/LoginPage.jsx` | Add onClick handlers to buttons |

---

## 📚 Quick Code References

### Using CSS Variables in Components
```jsx
<button style={{ backgroundColor: 'var(--color-primary)' }}>
  Click Me
</button>
```

### Adding New Icons
```jsx
import { IconName } from 'lucide-react';

<IconName size={24} className="text-gray-600" />
```

### Creating New Components
```jsx
export default function ComponentName() {
  return (
    <div className="bg-white dark:bg-gray-800">
      {/* Component content */}
    </div>
  );
}
```

### Tailwind Dark Mode Class
```jsx
<div className="bg-white dark:bg-gray-900 text-gray-900 dark:text-white">
  Content adapts to light and dark modes
</div>
```

---

## ✅ Pre-Launch Checklist

- [ ] Change primary color in `src/index.css`
- [ ] Update login page images
- [ ] Update admin avatar in Header
- [ ] Update navigation labels if needed
- [ ] Update KPI values/labels
- [ ] Update database health items
- [ ] Test dark mode
- [ ] Test on mobile devices
- [ ] Run `npm run build` for production
- [ ] Deploy to hosting service

---

## 📞 Getting Help

1. **Setup Issues**: Check `SETUP_GUIDE.md`
2. **Implementation Questions**: See `IMPLEMENTATION_SUMMARY.md`
3. **Documentation**: Read `README.md`
4. **Code References**: Check inline comments in component files
5. **Framework Docs**:
   - Tailwind: https://tailwindcss.com
   - React: https://react.dev
   - Lucide: https://lucide.dev
   - Recharts: https://recharts.org

---

## 🎓 Learning Resources

- **Tailwind CSS**: Official docs with component examples
- **React Hooks**: useState, useEffect, useContext
- **CSS Variables**: Dynamic theming without compilation
- **Dark Mode**: `prefers-color-scheme` and class-based approaches

---

**Last Updated**: March 2024
**Version**: 1.0.0
**Status**: Production Ready ✅

