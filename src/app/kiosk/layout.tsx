import localFont from "next/font/local";

// Bundled with the app so the booth keeps its look without an internet connection.
const display = localFont({
  src: "./fonts/Shrikhand-Regular.woff2",
  weight: "400",
  variable: "--kiosk-font-display",
  display: "swap",
});

const body = localFont({
  src: [
    { path: "./fonts/Figtree-400.woff2", weight: "400" },
    { path: "./fonts/Figtree-500.woff2", weight: "500" },
    { path: "./fonts/Figtree-600.woff2", weight: "600" },
    { path: "./fonts/Figtree-700.woff2", weight: "700" },
    { path: "./fonts/Figtree-800.woff2", weight: "800" },
  ],
  variable: "--kiosk-font-body",
  display: "swap",
});

export default function KioskLayout({ children }: LayoutProps<"/kiosk">) {
  return (
    <div className={`kiosk-fonts ${display.variable} ${body.variable}`}>
      {children}
    </div>
  );
}
