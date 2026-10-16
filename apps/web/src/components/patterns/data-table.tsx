import type { ReactNode } from "react";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface DataTableColumn<Row> {
  id: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  numeric?: boolean;
  className?: string;
}

export interface DataTableProps<Row> {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  getRowId: (row: Row) => string;
  caption?: ReactNode;
  footer?: ReactNode;
  empty?: ReactNode;
  selectedRowId?: string;
  className?: string;
}

export function DataTable<Row>({
  columns,
  rows,
  getRowId,
  caption,
  footer,
  empty,
  selectedRowId,
  className,
}: DataTableProps<Row>) {
  return (
    <div className={cn("overflow-hidden rounded-lg border bg-card", className)}>
      <Table>
        {caption ? <TableCaption className="pb-3">{caption}</TableCaption> : null}
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((column) => (
              <TableHead
                key={column.id}
                scope="col"
                numeric={column.numeric}
                className={column.className}
              >
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell
                colSpan={columns.length}
                className="py-8 text-center text-muted-foreground"
              >
                {empty ?? "No rows to show."}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => {
              const rowId = getRowId(row);
              return (
                <TableRow key={rowId} data-state={rowId === selectedRowId ? "selected" : undefined}>
                  {columns.map((column) => (
                    <TableCell
                      key={column.id}
                      numeric={column.numeric}
                      className={column.className}
                    >
                      {column.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })
          )}
        </TableBody>
        {footer ? <TableFooter>{footer}</TableFooter> : null}
      </Table>
    </div>
  );
}
