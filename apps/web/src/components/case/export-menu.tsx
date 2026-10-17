"use client";

import { Download, FileSpreadsheet, FileText, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface ExportMenuProps {
  deliverableTitle: string;
  docxUrl?: string;
  xlsxUrl?: string;
  jsonUrl?: string;
  onPrint: () => void;
}

export function ExportMenu({
  deliverableTitle,
  docxUrl,
  xlsxUrl,
  jsonUrl,
  onPrint,
}: ExportMenuProps) {
  const serverExportsAvailable = Boolean(docxUrl || xlsxUrl || jsonUrl);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`Export ${deliverableTitle}`}>
          <Download aria-hidden />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60 print:hidden">
        <DropdownMenuLabel>Export {deliverableTitle}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {docxUrl ? (
          <DropdownMenuItem asChild>
            <a href={docxUrl} download>
              <FileText aria-hidden />
              Word document (.docx)
            </a>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled>
            <FileText aria-hidden />
            Word document (.docx)
          </DropdownMenuItem>
        )}
        {xlsxUrl ? (
          <DropdownMenuItem asChild>
            <a href={xlsxUrl} download>
              <FileSpreadsheet aria-hidden />
              Schedules (.xlsx)
            </a>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled>
            <FileSpreadsheet aria-hidden />
            Schedules (.xlsx)
          </DropdownMenuItem>
        )}
        {jsonUrl ? (
          <DropdownMenuItem asChild>
            <a href={jsonUrl} download>
              <Download aria-hidden />
              Dashboard data (.json)
            </a>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={onPrint}>
          <Printer aria-hidden />
          Print or save as PDF
        </DropdownMenuItem>
        {serverExportsAvailable ? null : (
          <p className="px-2 pb-1.5 pt-1 text-xs text-muted-foreground">
            Word and Excel exports need the live API.
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
