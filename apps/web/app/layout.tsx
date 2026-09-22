import type { ReactNode } from 'react';

export const metadata = {
  title: 'Docklane',
  description: 'Lightweight self-hosted deployment control plane',
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
