import type { ReactNode } from "react";

/// Label and reason grouped on the left, control on the right and centred on the
/// pair — the two lines of text are one thing, and the control answers both.
///
/// `stacked` puts the control *under* the label at full width instead. That is for
/// a control too wide to share a line at all — the theme swatches — and it is also
/// where a picker wants to be: options ranged along one edge rather than pushed
/// against the far one.
///
/// `description` is optional only for a control that shows the reader the answer
/// instead of telling them: the theme swatches, and the mode segments while they
/// work. For a switch it is never optional — a switch is a word and a state, and the
/// sentence under it is the only place "why is this off by default" can live. A
/// control that has gone *disabled* always takes one too, whatever its shape, since
/// that sentence is then the only place the reason can be said.
///
/// `asGroup` is for a control that is several elements rather than one input:
/// `htmlFor` only reaches a labelable element, so a radio group has to be pointed the
/// other way and name the label by id instead.
export default function SettingRow({
  id,
  label,
  description,
  asGroup = false,
  stacked = false,
  trailing,
  children,
}: {
  id: string;
  label: string;
  /// A node, not a string: a row whose reason is best said with a mark beside
  /// it should not have to reach past this for the privilege.
  description?: ReactNode;
  asGroup?: boolean;
  stacked?: boolean;
  /// A hint about the control, such as the chord that cycles it: at the far end
  /// of a stacked row's label line, beside the control otherwise.
  trailing?: ReactNode;
  children: ReactNode;
}) {
  const labelEl = (
    <label
      id={asGroup ? id : undefined}
      htmlFor={asGroup ? undefined : id}
      className="text-ui font-medium"
    >
      {label}
    </label>
  );
  const descriptionEl = description && (
    <p className="text-ui text-muted-foreground">{description}</p>
  );

  if (stacked) {
    return (
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center justify-between gap-4">
            {labelEl}
            {trailing}
          </div>
          {descriptionEl}
        </div>
        {children}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        {labelEl}
        {descriptionEl}
      </div>
      <div className="flex shrink-0 items-center gap-4">
        {trailing}
        {children}
      </div>
    </div>
  );
}
