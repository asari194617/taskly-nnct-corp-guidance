"use client";

import { Button } from "@openameba/spindle-ui/Button";
import { Icon } from "./icons";

export default function IndustryChips({
  options,
  selected,
  onChange,
}: {
  options: string[];
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  return (
    <fieldset className="industry-chips">
      <legend className="sr-only">業種</legend>
      {options.map((value) => {
        const active = selected.includes(value);
        return (
          <Button
            key={value}
            size="small"
            variant={active ? "lighted" : "outlined"}
            aria-pressed={active}
            icon={active ? <Icon name="check" size={16} /> : undefined}
            onClick={() =>
              onChange(
                active
                  ? selected.filter((item) => item !== value)
                  : [...selected, value],
              )
            }
          >
            {value}
          </Button>
        );
      })}
    </fieldset>
  );
}
