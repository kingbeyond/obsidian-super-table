# Creative Library

Keep files, tags, and Markdown notes together. All artwork in this example is original demo content.

```super-table
{
  "schemaVersion": 1,
  "tableId": "demo-creative-library",
  "fields": [
    {
      "id": "asset",
      "name": "Asset",
      "type": "text",
      "width": 235
    },
    {
      "id": "category",
      "name": "Category",
      "type": "select",
      "width": 125,
      "options": [
        {
          "id": "web",
          "label": "Website",
          "color": "blue"
        },
        {
          "id": "brand",
          "label": "Brand",
          "color": "purple"
        },
        {
          "id": "content",
          "label": "Content",
          "color": "cyan"
        }
      ]
    },
    {
      "id": "tags",
      "name": "Tags",
      "type": "multiselect",
      "width": 180,
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
      ]
    },
    {
      "id": "files",
      "name": "Files",
      "type": "attachment",
      "width": 180
    },
    {
      "id": "notes",
      "name": "Notes",
      "type": "text",
      "width": 240
    },
    {
      "id": "ready",
      "name": "Ready",
      "type": "checkbox",
      "width": 120
    }
  ],
  "records": [
    {
      "id": "asset-1",
      "values": {
        "asset": "Homepage layout",
        "category": "web",
        "tags": [
          "design"
        ],
        "files": [
          "assets/homepage-layout.svg",
          "assets/color-palette.svg"
        ],
        "notes": "**Desktop** and mobile layouts",
        "ready": true
      }
    },
    {
      "id": "asset-2",
      "values": {
        "asset": "Brand palette",
        "category": "brand",
        "tags": [
          "design"
        ],
        "files": [
          "assets/color-palette.svg"
        ],
        "notes": "Approved accent colors",
        "ready": true
      }
    },
    {
      "id": "asset-3",
      "values": {
        "asset": "Launch illustration",
        "category": "content",
        "tags": [
          "design",
          "writing"
        ],
        "files": [
          "assets/launch-illustration.svg"
        ],
        "notes": "A simple visual for the launch",
        "ready": false
      }
    },
    {
      "id": "asset-4",
      "values": {
        "asset": "Writing checklist",
        "category": "content",
        "tags": [
          "writing"
        ],
        "files": [],
        "notes": "- [x] Draft\n- [ ] Review",
        "ready": false
      }
    }
  ],
  "views": [
    {
      "id": "library",
      "name": "Asset library",
      "filters": {
        "mode": "and",
        "conditions": []
      }
    }
  ],
  "defaultViewId": "library"
}
```
