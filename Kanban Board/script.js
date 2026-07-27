// KANBAN BOARD

// STATE
let tasksData={};   // { colId:[taskObj, ...] }
let dragEl=null;
let dragOverEl=null;
let undoStack=null; // { task, colId }
let undoTimer=null;
let editingId=null; // id of task being edited

const WIP_LIMIT={ todo:Infinity, progress:3, done:Infinity };

// DOM REFS
const colIds=['todo', 'progress', 'done'];
const lists={
  todo:document.getElementById('list-todo'),
  progress:document.getElementById('list-progress'),
  done:document.getElementById('list-done'),
};
const counts={
  todo:document.getElementById('count-todo'),
  progress:document.getElementById('count-progress'),
  done:document.getElementById('count-done'),
};
const wipBar={
  todo:document.getElementById('wip-todo'),
  progress:document.getElementById('wip-progress'),
  done:document.getElementById('wip-done'),
};
const columns={
  todo:document.getElementById('todo'),
  progress:document.getElementById('progress'),
  done:document.getElementById('done'),
};

const modal=document.getElementById('task-modal');
const modalBg=document.getElementById('modal-bg');
const modalClose=document.getElementById('modal-close');
const modalTitleTxt=document.getElementById('modal-title-text');
const modalSubmit=document.getElementById('modal-submit');
const titleInput=document.getElementById('task-title-input');
const descInput=document.getElementById('task-desc-input');
const priorityInput=document.getElementById('task-priority');
const dueInput=document.getElementById('task-due');
const editIdInput=document.getElementById('edit-task-id');

const toggleModalBtn=document.getElementById('toggle-modal');
const searchInput=document.getElementById('search-input');
const themeBtn=document.getElementById('theme-toggle');
const exportBtn=document.getElementById('export-btn');
const importBtn=document.getElementById('import-btn');
const importFile=document.getElementById('import-file');

const toast=document.getElementById('undo-toast');
const toastMsg=document.getElementById('toast-msg');
const undoBtn=document.getElementById('undo-btn');

const progressFill=document.getElementById('overall-progress');
const progressPct=document.getElementById('progress-pct');

// HELPERS
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function getNextSerial() {
  // Count total tasks actually on the board to get true serial
  // This prevents gaps/jumps when old localStorage data was wiped
  const total=colIds.reduce((sum, col) => {
    return sum + (tasksData[col] ? tasksData[col].length:0);
  }, 0);
  const serial=total + 1;
  return serial;
}

function formatDate(iso) {
  if (!iso) return '';
  const d=new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
}

function isOverdue(iso) {
  if (!iso) return false;
  const today=new Date(); today.setHours(0, 0, 0, 0);
  return new Date(iso + 'T00:00:00') < today;
}

function timeAgo(ts) {
  if (!ts||isNaN(Number(ts))) return '';
  const diff=Date.now() - Number(ts);
  if (diff < 0) return 'just now';
  const m=Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h=Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

// BUILD TASK CARD DOM
function buildTaskEl(task) {
  const div=document.createElement('div');
  div.className=`task pri-${task.priority||'medium'}`;
  div.setAttribute('draggable', 'true');
  div.dataset.id=task.id;

  // Labels HTML
  const labelsHtml=(task.labels||[]).map(l =>
    `<span class="task-label lbl-${l}">${l}</span>`
  ).join('');

  // Due date HTML
  const overdue=isOverdue(task.due);
  const dueHtml=task.due
    ? `<span class="task-due ${overdue ? 'overdue':''}">${overdue ? '⚠':'📅'} ${formatDate(task.due)}</span>`
    :'';

  div.innerHTML=`
    <div class="task-top">
      <span class="task-serial">Task #${task.serial}</span>
      <span class="task-priority-badge ${task.priority||'medium'}">${task.priority||'medium'}</span>
    </div>
    <h2>${task.title}</h2>
    ${task.desc ? `<p>${task.desc}</p>`:''}
    ${labelsHtml ? `<div class="task-labels">${labelsHtml}</div>`:''}
    ${dueHtml}
    <div class="task-actions">
      <button class="edit-btn">Edit</button>
      <button class="delete-btn">Delete</button>
    </div>
    <span class="task-time">${timeAgo(task.createdAt)}</span>
  `;

  // Drag events
  div.addEventListener('dragstart', e => {
    dragEl=div;
    e.dataTransfer.effectAllowed='move';
    setTimeout(() => div.classList.add('dragging'), 0);
  });
  div.addEventListener('dragend', () => {
    div.classList.remove('dragging');
    dragEl=null;
    document.querySelectorAll('.task-column').forEach(c => c.classList.remove('drag-over'));
  });

  // Reorder within column: dragover sibling
  div.addEventListener('dragover', e => {
    e.preventDefault();
    if (!dragEl||dragEl===div) return;
    const list=div.closest('.tasks-list');
    const rect=div.getBoundingClientRect();
    const mid=rect.top + rect.height / 2;
    if (e.clientY < mid) {
      list.insertBefore(dragEl, div);
    } else {
      list.insertBefore(dragEl, div.nextSibling);
    }
    updateAll();
  });

  // Edit
  div.querySelector('.edit-btn').addEventListener('click', () => openEditModal(task.id));

  // Delete
  div.querySelector('.delete-btn').addEventListener('click', () => {
    const colId=div.closest('.tasks-list').id.replace('list-', '');
    deleteTask(task.id, colId, div);
  });

  return div;
}

// ADD TASK
function addTask(taskObj, colId, prepend=false) {
  const list=lists[colId];
  const el=buildTaskEl(taskObj);
  const emptyState=list.querySelector('.empty-state');
  if (prepend) {
    // Insert before the first task card (or before empty-state if no tasks yet)
    const first=list.querySelector('.task');
    list.insertBefore(el, first||emptyState||null);
  } else {
    // Always insert before empty-state so card appears above it
    if (emptyState) {
      list.insertBefore(el, emptyState);
    } else {
      list.appendChild(el);
    }
  }
}

// DELETE TASK
function deleteTask(id, colId, el) {
  // Search globally - after a drag, the task may be in a different column's
  // tasksData than what colId says, so always do a full search
  const task=findTask(id);
  const actualColId=findTaskColId(id)||colId;
  if (!task) return;

  // animate out
  el.style.transition='opacity 0.18s, transform 0.18s';
  el.style.opacity='0';
  el.style.transform='scale(0.94)';
  setTimeout(() => { el.remove(); updateAll(); }, 180);

  // undo
  undoStack={ task:{ ...task }, colId:actualColId };
  showToast('Task deleted');
}

// EDIT TASK
function openEditModal(id) {
  const task=findTask(id);
  if (!task) return;
  editingId=id;

  modalTitleTxt.textContent='Edit Task';
  modalSubmit.textContent='Save Changes';
  titleInput.value=task.title;
  descInput.value=task.desc||'';
  priorityInput.value=task.priority||'medium';
  dueInput.value=task.due||'';
  editIdInput.value=id;

  // set label checkboxes
  document.querySelectorAll('.label-chips input[type=checkbox]').forEach(cb => {
    cb.checked=(task.labels||[]).includes(cb.value);
  });

  openModal();
}

function findTask(id) {
  // Search tasksData first, then fall back to scanning DOM data-id cards
  // so edit/delete still work even if tasksData hasn't synced yet
  for (const col of colIds) {
    const t=(tasksData[col]||[]).find(t => t.id===id);
    if (t) return t;
  }
  return null;
}

function findTaskColId(id) {
  // Search tasksData, then fall back to checking which list the DOM card is in
  for (const col of colIds) {
    if ((tasksData[col]||[]).find(t => t.id===id)) return col;
  }
  // Fallback: check DOM directly
  for (const col of colIds) {
    if (lists[col].querySelector(`.task[data-id="${id}"]`)) return col;
  }
  return null;
}

// SAVE / UPDATE
function updateAll() {
  // STEP 1: Build a flat lookup of ALL known tasks from current tasksData
  // BEFORE we start overwriting it column by column. This prevents the bug
  // where tasksData[col] gets wiped before findTask() can look it up.
  const allKnown={};
  colIds.forEach(col => {
    (tasksData[col]||[]).forEach(t => { if (t && t.id) allKnown[t.id]=t; });
  });

  // STEP 2: Now safely rebuild tasksData from the actual DOM order
  colIds.forEach(col => {
    const list=lists[col];
    const els=list.querySelectorAll('.task');
    const colTasks=Array.from(els)
      .map(el => allKnown[el.dataset.id]||null)
      .filter(Boolean);

    tasksData[col]=colTasks;
    counts[col].textContent=colTasks.length;

    // WIP limit warning
    if (col==='progress' && colTasks.length>=WIP_LIMIT.progress) {
      wipBar[col].style.display='block';
    } else {
      wipBar[col].style.display='none';
    }

    // Empty state: hide when tasks exist, show when column is empty
    const empty=list.querySelector('.empty-state');
    if (empty) empty.style.display=colTasks.length ? 'none':'flex';
  });

  // STEP 3: Update progress bar
  const total=colIds.reduce((s, c) => s + (tasksData[c]||[]).length, 0);
  const done=(tasksData['done']||[]).length;
  const pct=total ? Math.round((done / total) * 100):0;
  progressFill.style.width=pct + '%';
  progressPct.textContent=pct + '%';

  localStorage.setItem('tasks', JSON.stringify(tasksData));
}

// DRAG ON COLUMNS
colIds.forEach(col => {
  const column=columns[col];
  const list=lists[col];

  column.addEventListener('dragenter', e => {
    e.preventDefault();
    column.classList.add('drag-over');
  });
  column.addEventListener('dragleave', e => {
    if (!column.contains(e.relatedTarget)) column.classList.remove('drag-over');
  });
  column.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect='move';
  });
  column.addEventListener('drop', e => {
    e.preventDefault();
    column.classList.remove('drag-over');
    if (dragEl) {
      // Insert before empty-state so card always appears above it
      const emptyState=list.querySelector('.empty-state');
      if (emptyState) {
        list.insertBefore(dragEl, emptyState);
      } else {
        list.appendChild(dragEl);
      }
      updateAll();
    }
  });
});

// MODAL OPEN/CLOSE
function openModal() { modal.classList.add('active'); titleInput.focus(); }

function closeModal() {
  modal.classList.remove('active');
  editingId=null;
  editIdInput.value='';
  modalTitleTxt.textContent='New Task';
  modalSubmit.textContent='Add Task';
  titleInput.value=''; descInput.value='';
  priorityInput.value='medium'; dueInput.value='';
  document.querySelectorAll('.label-chips input[type=checkbox]').forEach(cb => cb.checked=false);
  titleInput.classList.remove('input-error');
}

toggleModalBtn.addEventListener('click', openModal);
modalBg.addEventListener('click', closeModal);
modalClose.addEventListener('click', closeModal);
document.addEventListener('keydown', e => {
  if (e.key==='Escape') closeModal();
  if (e.key==='n' && !modal.classList.contains('active') &&
      document.activeElement.tagName!=='INPUT' &&
      document.activeElement.tagName!=='TEXTAREA') {
    openModal();
  }
});
titleInput.addEventListener('keydown', e => { if (e.key==='Enter') modalSubmit.click(); });

// SUBMIT (ADD OR EDIT)
modalSubmit.addEventListener('click', () => {
  const title=titleInput.value.trim();
  const desc=descInput.value.trim();
  const priority=priorityInput.value;
  const due=dueInput.value;
  const labels=Array.from(
    document.querySelectorAll('.label-chips input[type=checkbox]:checked')
  ).map(cb => cb.value);

  if (!title) {
    titleInput.classList.add('input-error');
    titleInput.focus();
    setTimeout(() => titleInput.classList.remove('input-error'), 1500);
    return;
  }

  if (editingId) {
    // UPDATE existing task
    const colId=findTaskColId(editingId);
    const task=findTask(editingId);
    if (task) {
      task.title=title; task.desc=desc;
      task.priority=priority; task.due=due; task.labels=labels;
      // re-render that card
      const el=document.querySelector(`.task[data-id="${editingId}"]`);
      if (el) {
        const newEl=buildTaskEl(task);
        el.replaceWith(newEl);
      }
      updateAll();
    }
  } else {
    // ADD new task
    const task={
      id:genId(),
      serial:getNextSerial(),
      title, desc, priority, due, labels,
      createdAt:Date.now(),
    };
    if (!tasksData['todo']) tasksData['todo']=[];
    tasksData['todo'].push(task);
    addTask(task, 'todo', true);
    updateAll();
  }

  closeModal();
});

// UNDO TOAST
function showToast(msg) {
  toastMsg.textContent=msg;
  toast.classList.add('show');
  clearTimeout(undoTimer);
  undoTimer=setTimeout(() => {
    toast.classList.remove('show');
    undoStack=null;
  }, 4000);
}

undoBtn.addEventListener('click', () => {
  if (!undoStack) return;
  const { task, colId }=undoStack;
  if (!tasksData[colId]) tasksData[colId]=[];
  tasksData[colId].push(task);
  addTask(task, colId);
  updateAll();
  toast.classList.remove('show');
  undoStack=null;
  clearTimeout(undoTimer);
});

// SEARCH / FILTER
searchInput.addEventListener('input', () => {
  const q=searchInput.value.toLowerCase().trim();
  document.querySelectorAll('.task').forEach(el => {
    const title=el.querySelector('h2')?.textContent.toLowerCase()||'';
    const desc=el.querySelector('p')?.textContent.toLowerCase()||'';
    el.style.display=(!q||title.includes(q)||desc.includes(q)) ? '':'none';
  });
});

// DARK / LIGHT THEME
const savedTheme=localStorage.getItem('theme')||'dark';
document.documentElement.dataset.theme=savedTheme;
themeBtn.textContent=savedTheme==='dark' ? '☀':'☾';

themeBtn.addEventListener('click', () => {
  const curr=document.documentElement.dataset.theme;
  const next=curr==='dark' ? 'light':'dark';
  document.documentElement.dataset.theme=next;
  localStorage.setItem('theme', next);
  themeBtn.textContent=next==='dark' ? '☀':'☾';
});

// EXPORT JSON
exportBtn.addEventListener('click', () => {
  const blob=new Blob([JSON.stringify(tasksData, null, 2)], { type:'application/json' });
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='kanban-export.json';
  a.click();
});

// IMPORT JSON
importBtn.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', () => {
  const file=importFile.files[0];
  if (!file) return;
  const reader=new FileReader();
  reader.onload=e => {
    try {
      const data=JSON.parse(e.target.result);
      // clear board
      colIds.forEach(col => {
        lists[col].querySelectorAll('.task').forEach(t => t.remove());
      });
      tasksData={};
      for (const col in data) {
        if (!lists[col]) continue;
        tasksData[col]=[];
        data[col].forEach(task => {
          tasksData[col].push(task);
          addTask(task, col);
        });
      }
      updateAll();
    } catch { alert('Invalid JSON file.'); }
  };
  reader.readAsText(file);
  importFile.value='';
});

// LOAD FROM LOCALSTORAGE
// Valid tasks must have an "id"
// If old-format data is detected, wipe it so the board starts clean.
function isValidTask(t) {
  return t && typeof t==='object' && typeof t.id==='string' && t.id.length > 0;
}

const saved=localStorage.getItem('tasks');
if (saved) {
  try {
    const data=JSON.parse(saved);

    // Detect old-format data (any task missing an id field)
    let hasOldFormat=false;
    for (const col of colIds) {
      if ((data[col]||[]).some(t => !isValidTask(t))) {
        hasOldFormat=true;
        break;
      }
    }

    if (hasOldFormat) {
      // Wipe stale data - old tasks can't be edited or deleted in new code
      localStorage.removeItem('tasks');
      localStorage.removeItem('taskSerial');
    } else {
      // Load valid new-format tasks
      for (const col of colIds) {
        tasksData[col]=[];
        (data[col]||[]).forEach(task => {
          tasksData[col].push(task);
          addTask(task, col);
        });
      }
    }
  } catch {
    // Corrupted JSON - wipe and start fresh
    localStorage.removeItem('tasks');
    localStorage.removeItem('taskSerial');
    tasksData={};
  }
}
updateAll();