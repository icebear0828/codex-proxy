import React from "react";
import { Outlet, NavLink } from "react-router-dom";

export default function Layout() {
  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <nav className="w-64 flex-shrink-0 overflow-y-auto p-4 bg-white border-r border-gray-200 text-gray-700">
        <h2 className="text-lg font-bold mb-6 px-4">Dashboard</h2>
      <div className="mb-6">
        <h3 className="px-4 text-xs font-semibold uppercase tracking-wider opacity-60 mb-2">Dashboard Api</h3>
        <NavLink to="/dashboard-api/dashboard" className={({ isActive }) => `block px-4 py-2 text-sm rounded-md ${isActive ? "bg-blue-50 text-blue-700 border-r-2 border-blue-600" : "hover:bg-black/5"}`}>Dashboard</NavLink>
        <NavLink to="/dashboard-api/dashboard" className={({ isActive }) => `block px-4 py-2 text-sm rounded-md ${isActive ? "bg-blue-50 text-blue-700 border-r-2 border-blue-600" : "hover:bg-black/5"}`}>Account Management</NavLink>
        <NavLink to="/dashboard-api/dashboard" className={({ isActive }) => `block px-4 py-2 text-sm rounded-md ${isActive ? "bg-blue-50 text-blue-700 border-r-2 border-blue-600" : "hover:bg-black/5"}`}>Usage Stat</NavLink>
        <NavLink to="/dashboard-api/dashboard" className={({ isActive }) => `block px-4 py-2 text-sm rounded-md ${isActive ? "bg-blue-50 text-blue-700 border-r-2 border-blue-600" : "hover:bg-black/5"}`}>Usage Stats</NavLink>
        <NavLink to="/dashboard-api/edit" className={({ isActive }) => `block px-4 py-2 text-sm rounded-md ${isActive ? "bg-blue-50 text-blue-700 border-r-2 border-blue-600" : "hover:bg-black/5"}`}>Proxy Settings</NavLink>
      </div>
      </nav>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="h-14 flex items-center px-6 bg-white border-b border-gray-200 text-gray-900">
          <h1 className="text-sm font-medium">Dashboard</h1>
        </header>
        <main className="flex-1 overflow-y-auto p-6 bg-gray-50">
          <Outlet />
        </main>
      </div>
{/* Tailwind config from generated screens:

      tailwind.config = {
        darkMode: "class",
        theme: {
          extend: {
            colors: {
              "tertiary-fixed": "#d8e2ff",
              "on-primary-container": "#f6fff3",
              "surface-container-highest": "#e0e3e5",
              "primary": "#006b33",
              "secondary-fixed": "#e1e0ff",
              "on-background": "#191c1e",
              "secondary-fixed-dim": "#c0c1ff",
              "surface-dim": "#d8dadc",
              "primary-container": "#008743",
              "secondary-container": "#6063ee",
              "surface-tint": "#006d35",
              "error-container": "#ffdad6",
              "tertiary-fixed-dim": "#adc6ff",
              "on-secondary": "#ffffff",
              "on-primary": "#ffffff",
              "secondary": "#4648d4",
              "on-surface": "#191c1e",
              "primary-fixed-dim": "#61de87",
              "tertiary-container": "#2170e4",
              "on-surface-variant": "#3e4a3e",
              "on-primary-fixed-variant": "#005226",
              "on-secondary-container": "#fffbff",
              "inverse-primary": "#61de87",
              "surface-container-high": "#e6e8ea",
              "surface-variant": "#e0e3e5",
              "on-primary-fixed": "#00210c",
              "on-tertiary": "#ffffff",
              "on-error": "#ffffff",
              "on-tertiary-fixed-variant": "#004395",
              "surface-container-low": "#f2f4f6",
              "surface-container-lowest": "#ffffff",
              "error": "#ba1a1a",
              "surface-container": "#eceef0",
              "on-tertiary-container": "#fefcff",
              "background": "#f7f9fb",
              "on-error-container": "#93000a",
              "on-secondary-fixed": "#07006c",
              "on-secondary-fixed-variant": "#2f2ebe",
              "surface-bright": "#f7f9fb",
              "inverse-on-surface": "#eff1f3",
              "inverse-surface": "#2d3133",
              "outline-variant": "#bccabb",
              "on-tertiary-fixed": "#001a42",
              "surface": "#f7f9fb",
              "primary-fixed": "#7efba1",
              "outline": "#6d7a6d",
              "tertiary": "#0058be"
            },
            fontFamily: {
              "headline": ["Inter"],
              "body": ["Inter"],
              "label": ["Inter"],
              "mono": ["JetBrains Mono"]
            },
            borderRadius: {"DEFAULT": "0.25rem", "lg": "0.5rem", "xl": "0.75rem", "full": "9999px"},
          },
        },
      }
    
*/}
    </div>
  );
}

// Google Fonts:
// <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&amp;family=JetBrains+Mono:wght@400;500&amp;display=swap" rel="stylesheet"/>\n// <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&amp;display=swap" rel="stylesheet"/>\n// <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&amp;display=swap" rel="stylesheet"/>
