# Donivra - Setup & Customization Guide

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Start Development Server
```bash
npm start
```

The app will open at `http://localhost:3000`

### 3. View the Screens
- **Login Page**: Default landing - displays at startup
- **Admin Dashboard**: Click "Login to Account" to navigate to dashboard
- **Back to Login**: Use the navigation to return to login screen

---

## White-Label Configuration

### Changing the Primary Color

The entire app's branding is controlled by a single CSS variable. Change it once, and the entire app updates automatically.

#### Method 1: Edit CSS (Recommended)
1. Open `src/index.css`
2. Find the `:root` section
3. Update `--color-primary` to your brand color:

```css
:root {
  --color-primary: #FF6B35;        /* Your primary color */
  --color-primary-dark: #D84315;   /* Darker shade for hover */
  --color-primary-light: #FF8C5A;  /* Lighter shade for accents */
}
```

**Color combinations to try:**
- Red: Primary: `#EF4444`, Dark: `#991B1B`, Light: `#FCA5A5`
- Green: Primary: `#10B981`, Dark: `#065F46`, Light: `#6EE7B7`
- Purple: Primary: `#8B5CF6`, Dark: `#4C1D95`, Light: `#D8B4FE`
- Pink: Primary: `#EC4899`, Dark: `#831843`, Light: `#F472B6`

#### Method 2: Use Environment Variable
1. Create `.env.local` file in the root directory
2. Add: `REACT_APP_PRIMARY_COLOR=#YOUR_COLOR`
3. Restart the dev server

---

## Dark Mode

### Enable Dark Mode

The entire app supports dark mode. To test it:

#### Browser Console Method:
1. Open browser DevTools (F12)
2. Go to Console tab
3. Paste and run:
```javascript
document.documentElement.classList.add('dark');
```

To disable dark mode:
```javascript
document.documentElement.classList.remove('dark');
```

#### In Code:
Create a theme toggle hook or add this to your App component:

```javascript
const [darkMode, setDarkMode] = useState(false);

useEffect(() => {
  if (darkMode) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}, [darkMode]);
```

### Dark Mode Features
- All backgrounds adapt from white to dark gray
- Text colors automatically invert
- Cards and borders use appropriate dark shades
- The primary color adjusts for better dark mode visibility
- Charts remain readable with proper contrast

---

## Customizing Images

### Update Brand Images

#### Logo & Logo Icon
- File: All components with logo
- Current: Blue "A" icon
- To change: Search for the `<div>` with background color and update the icon text or replace with an image

#### Login Page Background Image
- File: `src/pages/LoginPage.jsx`
- Current URL: `https://images.unsplash.com/photo-1560066984-138dadb4c035?`
- To change: Replace the full `src` URL with your image

**High-quality Unsplash alternatives:**
- Professional salon: `https://images.unsplash.com/photo-1556228578-8c89e6adf883`
- Hair care: `https://images.unsplash.com/photo-1487412912498-e2f8cd1e515f`
- Styling: `https://images.unsplash.com/photo-1530268729831-4be100a9f57c`

#### Admin Profile Avatar
- File: `src/components/Header.jsx`
- Current URL: `https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d`
- To change: Replace the `src` URL in the profile image

**Professional avatar options:**
- Business woman: `https://images.unsplash.com/photo-1494790108377-be9c29b29330`
- Business man: `https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d`
- Professional: `https://images.unsplash.com/photo-1500648767791-00dcc994a43e`

---

## Component Customization

### Login Page Text Changes
File: `src/pages/LoginPage.jsx`

Key sections:
- Headline: `<h2 className="text-4xl font-bold">Every Strand Counts</h2>`
- Tagline: Update the `<p>` text
- Badge texts: "10K+ Donors" and "Empathetic Care"
- Form labels: "Email Address", "Password"
- Button text: "Login to Account"

### Dashboard Text Changes
File: `src/components/SystemHealthOverview.jsx` and related components

Key sections:
- Page title: "Overview"
- Section header: "System Health Overview"
- KPI titles: "SERVER UPTIME", "TOTAL ACTIVE USERS", etc.
- Quick Action labels: Button texts

### Navigation Items
File: `src/components/Sidebar.jsx`

Update the `navItems` array:
```javascript
const navItems = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'custom', label: 'Your Item', icon: YourIcon },
  // Add more items...
];
```

---

## Building for Production

### Create Production Build
```bash
npm run build
```

This creates an optimized build in the `build/` folder.

### Deploy to Netlify
1. Push to GitHub
2. Connect repo to Netlify
3. Build command: `npm run build`
4. Publish directory: `build`

### Deploy to Vercel
1. Push to GitHub
2. Import project in Vercel
3. Build settings are auto-detected
4. Deploy!

---

## Performance Tips

### Optimize Images
- Use real image URLs instead of placeholders
- Consider image CDN (Cloudflare, Imgix)
- Optimize file sizes with WebP format

### Add Code Splitting
For larger apps, implement React.lazy():
```javascript
const AdminDashboard = React.lazy(() => import('./pages/AdminDashboard'));
```

### Monitor Bundle Size
```bash
npm run build
npm install -g serve
serve -s build
```

---

## Responsive Design Adjustments

The current design is optimized for desktop (1920px+). To make it fully responsive:

1. **Sidebar on Mobile**: Add Hamburger menu
```javascript
const [sidebarOpen, setSidebarOpen] = useState(false);
// Toggle on mobile
```

2. **Grid Adaptations**: Update grid columns
- KPI Cards: `grid-cols-4` → `grid-cols-1 md:grid-cols-2 lg:grid-cols-4`
- Charts: `grid-cols-2` → `grid-cols-1 lg:grid-cols-2`
- Bottom Section: `grid-cols-3` → `grid-cols-1 lg:grid-cols-3`

3. **Hidden on Mobile**: Add `hidden md:block` to sidebar
```javascript
<Sidebar className="hidden md:block lg:block" />
```

---

## Troubleshooting

### Colors Not Updating
- Clear browser cache (Ctrl+Shift+Delete)
- Restart dev server (`npm start`)
- Check CSS variable syntax in `src/index.css`

### Dark Mode Not Working
- Ensure `dark:` classes are present
- Check Tailwind config has `darkMode: 'class'`
- Verify the `dark` class is added to `<html>` element

### Images Not Loading
- Check Unsplash URL is valid
- Ensure CORS is enabled
- Use `https://` not `http://`

### Charts Not Displaying
- Ensure Recharts is installed: `npm install recharts`
- Check ResponsiveContainer has height
- Verify data format in respective component

---

## Next Steps

1. ✅ Customize primary color to match your brand
2. ✅ Update logo and images
3. ✅ Update text and copy as needed
4. ✅ Test dark mode functionality
5. ✅ Integrate with your backend API
6. ✅ Add authentication logic
7. ✅ Deploy to production

---

## File Structure Quick Reference

```
src/
├── pages/
│   ├── LoginPage.jsx          <- Update login text, images, colors
│   └── AdminDashboard.jsx     <- Dashboard layout
├── components/
│   ├── Sidebar.jsx            <- Navigation items, logo
│   ├── Header.jsx             <- Profile image, title
│   ├── SystemHealthOverview.jsx <- Dashboard content
│   ├── KPICards.jsx           <- KPI values and labels
│   ├── Charts.jsx             <- Chart data and labels
│   ├── DatabaseHealth.jsx     <- Status items
│   └── QuickActions.jsx       <- Action buttons
├── App.jsx                    <- Main app, routing
├── index.js                   <- Entry point
└── index.css                  <- CSS variables, dark mode

src/index.css                  <- PRIMARY COLOR VARIABLE HERE ⭐
```

---

## Support Resources

- Tailwind CSS: https://tailwindcss.com/docs
- Lucide React Icons: https://lucide.dev/
- Recharts: https://recharts.org/
- React Docs: https://react.dev/

---

Built with ❤️ for Donivra

