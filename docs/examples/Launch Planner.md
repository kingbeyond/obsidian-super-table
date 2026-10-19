# Launch Planner

Plan a release in one note. Switch views to focus on the work that matters.

```super-table
{
  "schemaVersion": 1,
  "tableId": "demo-launch-planner",
  "fields": [
    {
      "id": "task",
      "name": "Task",
      "type": "text",
      "width": 220
    },
    {
      "id": "status",
      "name": "Status",
      "type": "select",
      "options": [
        {
          "id": "planned",
          "label": "Planned",
          "color": "gray"
        },
        {
          "id": "progress",
          "label": "In progress",
          "color": "blue"
        },
        {
          "id": "review",
          "label": "In review",
          "color": "purple"
        },
        {
          "id": "done",
          "label": "Done",
          "color": "green"
        }
      ],
      "width": 170
    },
    {
      "id": "priority",
      "name": "Priority",
      "type": "select",
      "options": [
        {
          "id": "high",
          "label": "High",
          "color": "red"
        },
        {
          "id": "normal",
          "label": "Normal",
          "color": "yellow"
        },
        {
          "id": "low",
          "label": "Low",
          "color": "gray"
        }
      ],
      "width": 155
    },
    {
      "id": "owner",
      "name": "Owner",
      "type": "text",
      "width": 130
    },
    {
      "id": "due",
      "name": "Due",
      "type": "date",
      "dateFormat": "iso-date",
      "width": 130
    },
    {
      "id": "tags",
      "name": "Tags",
      "type": "multiselect",
      "options": [
        {
          "id": "design",
          "label": "Design",
          "color": "purple"
        },
        {
          "id": "writing",
          "label": "Writing",
          "color": "cyan"
        },
        {
          "id": "engineering",
          "label": "Engineering",
          "color": "blue"
        }
      ],
      "width": 170
    },
    {
      "id": "effort",
      "name": "Hours",
      "type": "number",
      "width": 105
    },
    {
      "id": "approved",
      "name": "Ready",
      "type": "checkbox",
      "width": 110
    }
  ],
  "records": [
    {
      "id": "launch-1",
      "values": {
        "task": "Website copy",
        "status": "done",
        "priority": "high",
        "owner": "Avery",
        "due": "2026-10-21",
        "tags": [
          "writing"
        ],
        "effort": 4,
        "approved": true
      }
    },
    {
      "id": "launch-2",
      "values": {
        "task": "Product screenshots",
        "status": "progress",
        "priority": "high",
        "owner": "Riley",
        "due": "2026-10-22",
        "tags": [
          "design"
        ],
        "effort": 3,
        "approved": false
      }
    },
    {
      "id": "launch-3",
      "values": {
        "task": "Onboarding flow",
        "status": "review",
        "priority": "high",
        "owner": "Jordan",
        "due": "2026-10-23",
        "tags": [
          "design",
          "engineering"
        ],
        "effort": 8,
        "approved": false
      }
    },
    {
      "id": "launch-4",
      "values": {
        "task": "Help center",
        "status": "progress",
        "priority": "normal",
        "owner": "Avery",
        "due": "2026-10-24",
        "tags": [
          "writing"
        ],
        "effort": 6,
        "approved": false
      }
    },
    {
      "id": "launch-5",
      "values": {
        "task": "Release notes",
        "status": "planned",
        "priority": "normal",
        "owner": "Riley",
        "due": "2026-10-25",
        "tags": [
          "writing"
        ],
        "effort": 2,
        "approved": false
      }
    },
    {
      "id": "launch-6",
      "values": {
        "task": "Localization review",
        "status": "review",
        "priority": "normal",
        "owner": "Jordan",
        "due": "2026-10-26",
        "tags": [
          "writing",
          "design"
        ],
        "effort": 4,
        "approved": false
      }
    },
    {
      "id": "launch-7",
      "values": {
        "task": "Performance check",
        "status": "progress",
        "priority": "high",
        "owner": "Jordan",
        "due": "2026-10-27",
        "tags": [
          "engineering"
        ],
        "effort": 5,
        "approved": false
      }
    },
    {
      "id": "launch-8",
      "values": {
        "task": "Launch checklist",
        "status": "planned",
        "priority": "low",
        "owner": "Avery",
        "due": "2026-10-28",
        "tags": [
          "writing"
        ],
        "effort": 2,
        "approved": false
      }
    }
  ],
  "views": [
    {
      "id": "all",
      "name": "All tasks",
      "filters": {
        "mode": "and",
        "conditions": []
      },
      "visibleFieldIds": [
        "task",
        "status",
        "priority",
        "owner",
        "due",
        "tags",
        "effort"
      ]
    },
    {
      "id": "status",
      "name": "By status",
      "filters": {
        "mode": "and",
        "conditions": []
      },
      "group": {
        "fieldId": "status",
        "direction": "asc"
      },
      "visibleFieldIds": [
        "task",
        "status",
        "priority",
        "owner",
        "due",
        "tags",
        "effort"
      ]
    },
    {
      "id": "focus",
      "name": "High priority",
      "filters": {
        "mode": "and",
        "conditions": [
          {
            "id": "priority-high",
            "fieldId": "priority",
            "operator": "eq",
            "value": [
              "high"
            ]
          },
          {
            "id": "active-status",
            "fieldId": "status",
            "operator": "contains",
            "value": [
              "progress",
              "review"
            ]
          }
        ]
      },
      "sort": {
        "fieldId": "due",
        "direction": "asc"
      },
      "group": {
        "fieldId": "status",
        "direction": "asc"
      },
      "visibleFieldIds": [
        "task",
        "status",
        "priority",
        "owner",
        "due",
        "tags",
        "effort"
      ]
    }
  ],
  "defaultViewId": "all"
}
```
