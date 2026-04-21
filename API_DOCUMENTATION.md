# ABSAI Ticket Management API Documentation

## Base URL
```
http://localhost:9090/api
```

## Authentication
Most endpoints require authentication via JWT token in the Authorization header:
```
Authorization: Bearer <your-jwt-token>
```

## API Endpoints

### 1. Authentication Routes (`/api/auth`)

#### Login
- **POST** `/api/auth/login`
- **Body:**
  ```json
  {
    "email": "user@example.com",
    "password": "password123"
  }
  ```
- **Response:**
  ```json
  {
    "message": "Login successful",
    "token": "jwt-token-here",
    "user": {
      "id": "user-id",
      "name": "User Name",
      "title": "Developer",
      "email": "user@example.com",
      "role": "user"
    }
  }
  ```

#### Forgot Password
- **POST** `/api/auth/forgot-password`
- **Body:**
  ```json
  {
    "email": "user@example.com"
  }
  ```

#### Verify OTP
- **POST** `/api/auth/verify-otp`
- **Body:**
  ```json
  {
    "email": "user@example.com",
    "otp": "123456",
    "newPassword": "newpassword123"
  }
  ```

### 2. User Management Routes (`/api/users`)

#### Add Account (Admin/Manager only)
- **POST** `/api/users/add-account`
- **Headers:** `Authorization: Bearer <token>`
- **Body:**
  ```json
  {
    "name": "New User",
    "title": "Developer",
    "email": "newuser@example.com",
    "password": "password123",
    "role": "user"
  }
  ```

#### Delete Account (Admin/Manager only)
- **DELETE** `/api/users/delete-account/:userId`
- **Headers:** `Authorization: Bearer <token>`

#### Update User
- **PUT** `/api/users/update-user/:userId`
- **Headers:** `Authorization: Bearer <token>`
- **Body:**
  ```json
  {
    "name": "Updated Name",
    "title": "Senior Developer",
    "email": "newemail@example.com",
    "role": "manager"
  }
  ```
- **Note:** 
  - Users can update their own account (name, title, email)
  - Admin/Manager can update any user account
  - Only Admin/Manager can change user roles
  - All fields are optional

#### Change Password
- **PUT** `/api/users/change-password`
- **Headers:** `Authorization: Bearer <token>`
- **Body:**
  ```json
  {
    "currentPassword": "oldpassword",
    "newPassword": "newpassword123"
  }
  ```

#### Get All Users (Admin/Manager only)
- **GET** `/api/users/all-users`
- **Headers:** `Authorization: Bearer <token>`

#### Get User Profile
- **GET** `/api/users/profile`
- **Headers:** `Authorization: Bearer <token>`

#### Update Own Profile
- **PUT** `/api/users/update-profile`
- **Headers:** `Authorization: Bearer <token>`
- **Body:**
  ```json
  {
    "name": "Updated Name",
    "title": "Senior Developer",
    "email": "newemail@example.com"
  }
  ```
- **Note:** 
  - Users can update their own profile information
  - All fields are optional
  - Cannot change role (use update-user for that with admin rights)

### 3. Project Routes (`/api/projects`)

#### Add Project (Admin/Manager only)
- **POST** `/api/projects/add-project`
- **Headers:** `Authorization: Bearer <token>`
- **Body:**
  ```json
  {
    "project_name": "New Project",
    "start_date": "2024-01-01",
    "estimated_end_date": "2024-06-01",
    "assigned_users": ["user-id-1", "user-id-2"]
  }
  ```

#### Assign Users to Project (Admin/Manager only)
- **PUT** `/api/projects/assign-users/:projectId`
- **Headers:** `Authorization: Bearer <token>`
- **Body:**
  ```json
  {
    "assigned_users": ["user-id-1", "user-id-2"]
  }
  ```

#### Get My Projects
- **GET** `/api/projects/my-projects`
- **Headers:** `Authorization: Bearer <token>`
- **Note:** Regular users see only assigned projects, Admin/Manager see all projects

#### Get Single Project
- **GET** `/api/projects/:projectId`
- **Headers:** `Authorization: Bearer <token>`

#### Update Project Status (Admin/Manager only)
- **PUT** `/api/projects/:projectId/status`
- **Headers:** `Authorization: Bearer <token>`
- **Body:**
  ```json
  {
    "status": "completed"
  }
  ```

### 4. Ticket Routes (`/api/tickets`)

#### Add Ticket
- **POST** `/api/tickets/add-ticket`
- **Headers:** `Authorization: Bearer <token>`
- **Body:**
  ```json
  {
    "project": "project-id",
    "ticket": "project_001",
    "requested_from": "John Doe",
    "requested_from_email": "john@example.com",
    "requested_to": "Jane Smith",
    "requested_to_email": "jane@example.com",
    "date": "2024-01-01",
    "time": "10:00 AM",
    "description": "Ticket description here",
    "handler": ["handler1@example.com", "handler2@example.com"],
    "status": "open"
  }
  ```
- **Note:** 
  - Required fields: `project`, `ticket`, `requested_from`, `requested_from_email`, `requested_to`, `requested_to_email`, and `description`
  - `handler` can be a single email string or an array of email addresses
  - Handler emails will be added as CC recipients in email notifications

#### Edit Ticket
- **PUT** `/api/tickets/edit-ticket/:ticketId`
- **Headers:** `Authorization: Bearer <token>`
- **Body:**
  ```json
  {
    "project": "project-id",
    "requested_from": "John Doe",
    "requested_from_email": "john@example.com",
    "requested_to": "Jane Smith",
    "requested_to_email": "jane@example.com",
    "date": "2024-01-01",
    "time": "10:00 AM",
    "description": "Updated description",
    "handler": ["handler1@example.com", "handler2@example.com"],
    "status": "in_progress",
    "comment": "Working on this issue",
    "end_date": "2024-01-10"
  }
  ```
- **Note:** 
  - All fields are optional, update only what you need
  - Handler emails will be added as CC recipients in email notifications

#### Get My Tickets
- **GET** `/api/tickets/my-tickets`
- **Headers:** `Authorization: Bearer <token>`
- **Note:** Regular users see tickets they are involved in (requested_from, requested_to, or handler), Admin/Manager see all tickets

#### Get All Tickets (Admin/Manager only)
- **GET** `/api/tickets/`
- **Headers:** `Authorization: Bearer <token>`

#### Search Tickets by Pattern
- **GET** `/api/tickets/search/:ticketPattern`
- **Headers:** `Authorization: Bearer <token>`
- **Example:** `/api/tickets/search/project_001`

#### Get Single Ticket
- **GET** `/api/tickets/:ticketId`
- **Headers:** `Authorization: Bearer <token>`

#### Get Tickets by Status
- **GET** `/api/tickets/filter/status/:status`
- **Headers:** `Authorization: Bearer <token>`
- **Status values:** `open`, `in_progress`, `resolved`, `closed`, `pending`

## User Roles
- **admin**: Full access to all features
- **manager**: Can manage users and projects, view all tickets
- **developer**: Can view assigned projects and tickets
- **tester**: Can view assigned projects and tickets
- **user**: Basic user access

## Email Notifications
- Automatic email notifications are sent when:
  - A new ticket is created
  - A ticket is updated
  - Password reset OTP is sent

## Error Responses
All endpoints return appropriate HTTP status codes and error messages:
- `400`: Bad Request
- `401`: Unauthorized
- `403`: Forbidden
- `404`: Not Found
- `500`: Internal Server Error

## Default Admin User
The system automatically creates a default admin user on first startup:
- **Email**: admin@admin.com
- **Password**: 123456
- **Role**: admin
- **Name**: admin
- **Title**: admin

**Important**: Change the default password after first login for security.

## Setup Instructions
1. Install dependencies: `npm install`
2. Create `.env` file with your configuration
3. Start the server: `npm start`
4. Test the health endpoint: `GET http://localhost:9090/health`
5. Login with default admin credentials to get started

## Manual Database Seeding
If you need to manually seed the database:
```bash
npm run seed
```
