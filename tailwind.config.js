const shades = name => Object.fromEntries([50,100,200,300,400,500,600,700,800,900].map(k => [k, `rgb(var(--${name}-${k}) / <alpha-value>)`]));

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{html,ts,scss}"],
  theme: {
    extend: {
      fontFamily: {
        sans:    ['DM Sans Variable', 'DM Sans', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['Fraunces Variable', 'Fraunces', 'Georgia', 'serif'],
        mono:    ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        admin: {
          bg0:  '#04091a', bg1: '#070d1f', bg2: '#0d1529', bg3: '#111b35', bg4: '#1a2540',
          cyan: '#06b6d4', cyan2: '#22d3ee',
          amber: '#f59e0b', green: '#10b981', red: '#ef4444', blue: '#3b82f6',
          border: 'rgba(255,255,255,0.07)',
        },
        // Couleur de marque : définie par la société (Paramètres → Identité), appliquée par variables CSS.
        blue:   shades('brand'),
        brand:  shades('brand'),
        accent: shades('accent'),
      },
      animation: {
        'fade-in':    'fadeIn 0.3s ease-in-out',
        'slide-up':   'slideUp 0.3s ease-out',
        'pulse-slow': 'pulse 2s cubic-bezier(0.4,0,0.6,1) infinite',
        'spin-slow':  'spin 3s linear infinite',
      },
      keyframes: {
        fadeIn:  {'0%':{opacity:'0'},'100%':{opacity:'1'}},
        slideUp: {'0%':{opacity:'0',transform:'translateY(10px)'},'100%':{opacity:'1',transform:'translateY(0)'}},
      },
    },
  },
  plugins: [],
};
