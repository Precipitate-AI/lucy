/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
      "./pages/**/*.{js,ts,jsx,tsx,mdx}",
      "./components/**/*.{js,ts,jsx,tsx,mdx}", // Add this if you plan to use a components folder
    ],
    theme: {
      extend: {},
    },
    plugins: [
      require('@tailwindcss/typography'), // You installed this
    ],
  }
  