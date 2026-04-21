const mongoose = require('mongoose');
require('dotenv').config();

const { Conversation } = require('../models/chat');
const { Project } = require('../models');

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://ticketing_user:TicketApp2025!@localhost:27017/ticketing_db?authSource=ticketing_db')
.then(() => {
  console.log('Connected to MongoDB');
  createMissingConversations();
})
.catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
});

async function createMissingConversations() {
  try {
    console.log('Starting to create project conversations...');
    
    // Get all projects
    const projects = await Project.find({}).populate('assigned_users');
    
    console.log(`Found ${projects.length} projects`);
    
    let created = 0;
    let existing = 0;
    
    for (const project of projects) {
      // Check if conversation already exists
      const existingConv = await Conversation.findOne({ project: project._id });
      
      if (existingConv) {
        console.log(`Conversation already exists for project: ${project.project_name}`);
        existing++;
        
        // Update participants if needed
        const participantIds = project.assigned_users.map(u => u._id);
        if (existingConv.participants.length !== participantIds.length ||
            !participantIds.every(id => existingConv.participants.some(p => p.toString() === id.toString()))) {
          existingConv.participants = participantIds;
          existingConv.groupName = project.project_name;
          await existingConv.save();
          console.log(`Updated participants for project: ${project.project_name}`);
        }
      } else {
        // Create new conversation
        const conversation = new Conversation({
          participants: project.assigned_users.map(u => u._id),
          isGroup: true,
          groupName: project.project_name,
          project: project._id,
          groupAdmin: project.assigned_users[0]?._id || null
        });
        
        await conversation.save();
        console.log(`Created conversation for project: ${project.project_name}`);
        created++;
      }
    }
    
    console.log(`\nSummary:`);
    console.log(`- Created: ${created} conversations`);
    console.log(`- Already existed: ${existing} conversations`);
    console.log(`- Total projects: ${projects.length}`);
    
    mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('Error creating conversations:', error);
    mongoose.connection.close();
    process.exit(1);
  }
}

