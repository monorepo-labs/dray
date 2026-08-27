import { cn } from "@/lib/utils";

/// Linear's mark.
///
/// Drawn wherever the reader is being asked about Linear *specifically* — the
/// connect form and the settings row — and nowhere else. Everywhere else the
/// surface says "issue", because a second tracker should cost a module and not
/// a rename of every panel; the logo is the one place naming it is the point,
/// since it is what makes "paste a key" recognisable before the sentence
/// under it is read.
///
/// `currentColor`, not brand purple: this sits in a row of muted chrome, and
/// a single saturated logo would be the loudest thing on a surface whose job
/// is to be quiet.
export default function LinearIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={cn("size-4 shrink-0", className)}
      fill="currentColor"
      role="img"
      aria-label="Linear"
    >
      <path d="M1.22541 61.5228c-.2225-.9485.90748-1.5459 1.59638-.857L38.3326 96.1793c.6889.6889.0915 1.8189-.857 1.5964C19.1583 93.4468 4.5532 78.8417 1.22541 61.5228ZM.00189135 46.8891c-.01764375.2833.08887215.5599.28957165.7606L52.3503 99.7085c.2007.2007.4773.3075.7606.2896 2.3692-.1476 4.6938-.46 6.9624-.9259.7645-.157 1.0301-1.0963.4782-1.6481L2.57595 39.4485c-.55186-.5519-1.49117-.2863-1.648174.4782-.465915 2.2686-.77832 4.5932-.92588465 6.9624ZM4.21093 29.7054c-.16649.3738-.08169.8106.20765 1.1l64.77602 64.776c.2894.2894.7262.3742 1.1.2077 1.7861-.7956 3.5171-1.6927 5.1855-2.684.5521-.328.6373-1.0867.1832-1.5407L8.43566 24.3367c-.45409-.4541-1.21271-.3689-1.54074.1832-.99132 1.6684-1.88843 3.3994-2.68399 5.1855ZM12.6587 18.074c-.3701-.3701-.393-.9637-.0443-1.3541C21.7795 6.45931 35.1114 0 49.9997 0 77.6142 0 100 22.3858 100 50c0 14.8883-6.4593 28.2202-16.7199 37.3856-.3903.3487-.984.3258-1.354-.0443L12.6587 18.074Z" />
    </svg>
  );
}
