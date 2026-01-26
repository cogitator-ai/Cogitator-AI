import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Cogitator Next.js Example',
  description: 'Example chat app using @cogitator-ai/next',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          padding: 0,
          backgroundColor: '#0d0a14',
          color: '#fff',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          minHeight: '100vh',
        }}
      >
        {children}
      </body>
    </html>
  );
}
