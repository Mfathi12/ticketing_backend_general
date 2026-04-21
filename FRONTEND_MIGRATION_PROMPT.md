# Frontend Migration Prompt for Image Upload System

## Context
The backend has been updated to use file uploads instead of base64 images. This change significantly reduces API response sizes and improves performance. The backend still accepts base64 for backward compatibility, but the recommended approach is to use file uploads.

## Backend Changes Summary

### New Endpoints:
1. **Upload Images**: `POST /api/upload/ticket-images`
   - Accepts: `multipart/form-data` with `images` field (multiple files)
   - Returns: `{ images: ["/uploads/tickets/image-123.jpg", ...] }`
   - Requires: Authentication token

2. **Delete Image**: `DELETE /api/upload/ticket-images/:filename`
   - Requires: Authentication token

### Updated Endpoints:
- `POST /api/tickets/add-ticket` - Now accepts image URLs instead of base64
- `PUT /api/tickets/edit-ticket/:ticketId` - Now accepts image URLs instead of base64
- `GET /api/tickets/*` - Returns image URLs (not base64) - images are already excluded from list responses

### Image URLs Format:
- Images are served as static files: `http://your-server/uploads/tickets/filename.jpg`
- Database stores URLs like: `/uploads/tickets/image-123.jpg`
- Full URL: `http://your-server/uploads/tickets/image-123.jpg`

## Frontend Migration Tasks

### 1. Create Image Upload Service/Utility

Create a utility function to handle image uploads:

```typescript
// utils/imageUpload.ts or services/imageService.ts

interface UploadResponse {
  success: boolean;
  images: string[];
  count: number;
  message?: string;
}

export const uploadTicketImages = async (
  files: File[],
  token: string
): Promise<string[]> => {
  const formData = new FormData();
  files.forEach((file) => {
    formData.append('images', file);
  });

  const response = await fetch(`${API_BASE_URL}/api/upload/ticket-images`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      // Don't set Content-Type header - browser will set it with boundary
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to upload images');
  }

  const data: UploadResponse = await response.json();
  return data.images; // Returns array of URLs
};

export const deleteTicketImage = async (
  filename: string,
  token: string
): Promise<void> => {
  const response = await fetch(
    `${API_BASE_URL}/api/upload/ticket-images/${filename}`,
    {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error('Failed to delete image');
  }
};

// Helper to get full image URL
export const getImageUrl = (imagePath: string): string => {
  if (imagePath.startsWith('http')) {
    return imagePath; // Already full URL
  }
  return `${API_BASE_URL}${imagePath}`; // Prepend base URL
};
```

### 2. Update Ticket Creation Form

**Before (Base64 approach):**
```typescript
// OLD - Don't use this anymore
const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
  const files = Array.from(e.target.files || []);
  const base64Promises = files.map(file => {
    return new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(file);
    });
  });
  
  Promise.all(base64Promises).then(base64Images => {
    setImages(base64Images); // Storing base64 strings
  });
};

const handleSubmit = async () => {
  await createTicket({
    ...formData,
    images: images, // Sending base64 strings - TOO LARGE!
  });
};
```

**After (File Upload approach):**
```typescript
// NEW - Recommended approach
const [imageFiles, setImageFiles] = useState<File[]>([]);
const [uploadedImageUrls, setUploadedImageUrls] = useState<string[]>([]);
const [uploading, setUploading] = useState(false);

const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
  const files = Array.from(e.target.files || []);
  setImageFiles(files);
};

const uploadImages = async () => {
  if (imageFiles.length === 0) return [];
  
  setUploading(true);
  try {
    const urls = await uploadTicketImages(imageFiles, authToken);
    setUploadedImageUrls(urls);
    return urls;
  } catch (error) {
    console.error('Image upload failed:', error);
    throw error;
  } finally {
    setUploading(false);
  }
};

const handleSubmit = async () => {
  try {
    // Step 1: Upload images first
    const imageUrls = await uploadImages();
    
    // Step 2: Create ticket with image URLs
    await createTicket({
      ...formData,
      images: imageUrls, // Small URLs, not base64!
    });
  } catch (error) {
    // Handle error
  }
};
```

### 3. Update Ticket Edit Form

Similar changes for editing tickets:

```typescript
const [existingImages, setExistingImages] = useState<string[]>([]);
const [newImageFiles, setNewImageFiles] = useState<File[]>([]);
const [uploading, setUploading] = useState(false);

const handleNewImages = (e: React.ChangeEvent<HTMLInputElement>) => {
  const files = Array.from(e.target.files || []);
  setNewImageFiles(files);
};

const handleRemoveImage = async (imageUrl: string) => {
  // Extract filename from URL
  const filename = imageUrl.split('/').pop();
  if (filename) {
    await deleteTicketImage(filename, authToken);
    setExistingImages(prev => prev.filter(url => url !== imageUrl));
  }
};

const handleUpdate = async () => {
  try {
    let allImageUrls = [...existingImages];
    
    // Upload new images if any
    if (newImageFiles.length > 0) {
      setUploading(true);
      const newUrls = await uploadTicketImages(newImageFiles, authToken);
      allImageUrls = [...allImageUrls, ...newUrls];
    }
    
    // Update ticket with all image URLs
    await updateTicket(ticketId, {
      ...formData,
      images: allImageUrls,
    });
  } catch (error) {
    // Handle error
  } finally {
    setUploading(false);
  }
};
```

### 4. Update Image Display Components

**Before:**
```tsx
// OLD - Using base64
<img src={image} alt="Ticket image" />
```

**After:**
```tsx
// NEW - Using URLs
import { getImageUrl } from '@/utils/imageUpload';

<img 
  src={getImageUrl(image)} 
  alt="Ticket image" 
  onError={(e) => {
    // Handle broken image
    e.currentTarget.src = '/placeholder-image.png';
  }}
/>
```

### 5. Update API Service Functions

Update your ticket API service:

```typescript
// services/ticketService.ts

export const createTicket = async (ticketData: CreateTicketData) => {
  const response = await fetch(`${API_BASE_URL}/api/tickets/add-ticket`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      ...ticketData,
      images: ticketData.images, // Now expects URLs array, not base64
    }),
  });
  
  return response.json();
};

export const updateTicket = async (
  ticketId: string,
  ticketData: UpdateTicketData
) => {
  const response = await fetch(
    `${API_BASE_URL}/api/tickets/edit-ticket/${ticketId}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        ...ticketData,
        images: ticketData.images, // Now expects URLs array, not base64
      }),
    }
  );
  
  return response.json();
};
```

### 6. Handle Image Preview (Before Upload)

Show preview of selected images before uploading:

```tsx
const [imagePreviews, setImagePreviews] = useState<string[]>([]);

const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
  const files = Array.from(e.target.files || []);
  setImageFiles(files);
  
  // Create previews for UI
  const previews = files.map(file => URL.createObjectURL(file));
  setImagePreviews(previews);
};

// Cleanup previews
useEffect(() => {
  return () => {
    imagePreviews.forEach(preview => URL.revokeObjectURL(preview));
  };
}, [imagePreviews]);

// In JSX
{imagePreviews.map((preview, index) => (
  <img key={index} src={preview} alt={`Preview ${index}`} />
))}
```

### 7. Add Loading States and Error Handling

```tsx
const [uploadProgress, setUploadProgress] = useState(0);

// For better UX, you might want to show upload progress
// Note: Native fetch doesn't support progress, consider using axios or XMLHttpRequest
```

### 8. Update TypeScript Types

```typescript
// types/ticket.ts

export interface Ticket {
  _id: string;
  ticket: string;
  // ... other fields
  images: string[]; // Changed from base64 strings to URLs
}

export interface CreateTicketData {
  // ... other fields
  images?: string[]; // Array of image URLs
}

export interface UpdateTicketData {
  // ... other fields
  images?: string[]; // Array of image URLs
}
```

## Migration Checklist

- [ ] Create image upload utility/service
- [ ] Update ticket creation form to upload images first, then create ticket
- [ ] Update ticket edit form to handle image uploads/deletions
- [ ] Update image display components to use URLs
- [ ] Update API service functions
- [ ] Add image preview functionality
- [ ] Add loading states for image uploads
- [ ] Add error handling for failed uploads
- [ ] Update TypeScript types
- [ ] Test image upload flow
- [ ] Test image deletion
- [ ] Test with existing tickets (backward compatibility)
- [ ] Remove base64 conversion code (optional - backend still supports it)

## Important Notes

1. **Image URLs**: The backend returns relative paths like `/uploads/tickets/image.jpg`. You need to prepend your API base URL to get the full URL.

2. **Backward Compatibility**: The backend still accepts base64 images and converts them automatically. However, using file uploads is strongly recommended.

3. **File Size Limits**: Backend accepts up to 10MB per file. Add client-side validation.

4. **Multiple Images**: You can upload multiple images in one request (up to 10).

5. **Image Deletion**: When deleting images, extract the filename from the URL path.

6. **Error Handling**: Always handle upload failures gracefully and show user-friendly error messages.

7. **Performance**: This change significantly improves performance - API responses are now much smaller.

## Example Complete Flow

```typescript
// Complete example for creating a ticket with images

const CreateTicketForm = () => {
  const [formData, setFormData] = useState({...});
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [uploadedImages, setUploadedImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      // Step 1: Upload images
      setUploading(true);
      const imageUrls = await uploadTicketImages(imageFiles, authToken);
      setUploadedImages(imageUrls);
      
      // Step 2: Create ticket with image URLs
      const ticket = await createTicket({
        ...formData,
        images: imageUrls,
      });
      
      // Success!
      navigate(`/tickets/${ticket._id}`);
    } catch (error) {
      // Handle error
      showError('Failed to create ticket');
    } finally {
      setUploading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      {/* Form fields */}
      <input
        type="file"
        multiple
        accept="image/*"
        onChange={(e) => setImageFiles(Array.from(e.target.files || []))}
      />
      <button type="submit" disabled={uploading}>
        {uploading ? 'Uploading...' : 'Create Ticket'}
      </button>
    </form>
  );
};
```

## Testing

Test the following scenarios:
1. Upload single image
2. Upload multiple images
3. Create ticket with images
4. Edit ticket - add new images
5. Edit ticket - remove existing images
6. Display images in ticket list/detail
7. Handle upload failures
8. Handle network errors
9. Test with large images (near 10MB limit)
10. Test with different image formats (jpg, png, etc.)

