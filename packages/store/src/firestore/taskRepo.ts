import { taskSchema } from "@evianta/core";
import type { Firestore } from "firebase-admin/firestore";

import { StoreConflictError } from "../errors.js";
import { applyTaskUpdate } from "../mutations.js";
import type { TaskRepo } from "../types.js";
import {
  caseSubcollection,
  createDocAsync,
  listInInsertionOrderAsync,
  mutateDocAsync,
  nextOrder,
  orderField,
  toFirestoreData,
} from "./helpers.js";
import { leaseGuard } from "./lease.js";

export function createTaskRepo(db: Firestore): TaskRepo {
  return {
    async createTaskAsync(input) {
      const task = taskSchema.parse(input);

      await createDocAsync(caseSubcollection(db, task.caseId, "tasks").doc(task.id), task, "task");

      return task;
    },
    async createTasksAsync(caseId, inputs, fence) {
      const tasks = inputs.map((input) => taskSchema.parse(input));
      const ids = new Set<string>();

      for (const task of tasks) {
        if (task.caseId !== caseId) {
          throw new Error(`Task "${task.id}" does not belong to case "${caseId}".`);
        }

        if (ids.has(task.id)) {
          throw new StoreConflictError("task", task.id);
        }

        ids.add(task.id);
      }

      const entries = tasks.map((task) => ({
        task,
        ref: caseSubcollection(db, caseId, "tasks").doc(task.id),
      }));
      const guard = leaseGuard(db, caseId, fence);

      await db.runTransaction(async (transaction) => {
        await guard?.(transaction);
        const refs = entries.map((entry) => entry.ref);
        const existing = refs.length > 0 ? await transaction.getAll(...refs) : [];
        const conflict = existing.find((snapshot) => snapshot.exists);

        if (conflict) {
          throw new StoreConflictError("task", conflict.id);
        }

        for (const { task, ref } of entries) {
          transaction.create(ref, toFirestoreData({ ...task, [orderField]: nextOrder() }));
        }
      });

      return tasks;
    },
    async getTasksForCaseAsync(caseId) {
      return listInInsertionOrderAsync(caseSubcollection(db, caseId, "tasks"), taskSchema);
    },
    async updateTaskAsync(caseId, taskId, update, fence) {
      return mutateDocAsync(
        db,
        caseSubcollection(db, caseId, "tasks").doc(taskId),
        taskSchema,
        "task",
        (current) => applyTaskUpdate(current, update),
        leaseGuard(db, caseId, fence),
      );
    },
  };
}
