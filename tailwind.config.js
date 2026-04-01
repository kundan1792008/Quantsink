/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      keyframes: {
        pulse3d: {
          "0%, 100%": { transform: "scale(1) rotateX(0deg)", opacity: "0.8" },
          "50%": { transform: "scale(1.04) rotateX(4deg)", opacity: "1" },
        },
      },
      animation: {
        pulse3d: "pulse3d 2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
