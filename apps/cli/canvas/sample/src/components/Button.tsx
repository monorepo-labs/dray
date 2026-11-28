type ButtonProps = {
  children: React.ReactNode;
  variant?: "primary" | "secondary";
  className?: string;
};

export function Button({ children, variant = "primary", className = "" }: ButtonProps) {
  const look =
    variant === "primary"
      ? "bg-brand-600 text-white hover:bg-brand-700"
      : "bg-white text-ink ring-1 ring-line hover:bg-brand-50";
  return (
    <button
      type="button"
      className={`inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold transition-colors ${look} ${className}`}
    >
      {children}
    </button>
  );
}
