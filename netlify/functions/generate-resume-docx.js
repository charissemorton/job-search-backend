// Generate Professional DOCX Resume
// Uses docx library to create properly formatted Word documents

const { Document, Packer, Paragraph, TextRun, AlignmentType, LevelFormat, BorderStyle } = require('docx');

// Layout constants (twips; 1440 = 1 inch)
const SECTION_SPACING_BEFORE = 240;  // above each section heading
const SECTION_SPACING_AFTER  = 80;   // below each section heading (was 120)
const ROLE_SPACING_BEFORE    = 200;  // above each role header, so roles don't
                                     // run into the previous role's bullets

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }

  // Only accept POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: {
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { resumeText, profileData } = JSON.parse(event.body);

    if (!resumeText || !profileData) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ error: 'Missing resumeText or profileData' })
      };
    }

    // Parse resume text into sections
    const sections = parseResumeText(resumeText);
    
    // Create professional Word document
    const doc = createProfessionalResume(sections, profileData);
    
    // Generate buffer
    const buffer = await Packer.toBuffer(doc);
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${profileData.name.replace(/\s+/g, '_')}_Resume.docx"`,
        'Access-Control-Allow-Origin': '*',
      },
      body: buffer.toString('base64')
    };

  } catch (error) {
    console.error('Error generating resume:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: error.message })
    };
  }
};

/**
 * Parse resume text into structured sections
 */
function parseResumeText(resumeText) {
  const lines = resumeText.split('\n').filter(l => {
    const t = l.trim();
    return t && !/^[-*_]{3,}$/.test(t); // Remove separator lines
  });

  const sections = [];
  let currentSection = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    
    // Remove leading separators like "---## Header"
    line = line.replace(/^[-*_]{3,}\s*/, '');
    
    // Check if it's a markdown header
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      // Save previous section
      if (currentSection) {
        sections.push(currentSection);
      }
      
      // Start new section
      currentSection = {
        type: 'section',
        title: headerMatch[2],
        level: headerMatch[1].length,
        content: []
      };
      continue;
    }
    
    // Check if ALL CAPS (alternative header style)
    const cleanLine = line.replace(/\*\*/g, '');
    const isAllCaps = cleanLine === cleanLine.toUpperCase() && cleanLine.length > 2;
    
    if (isAllCaps) {
      // Save previous section
      if (currentSection) {
        sections.push(currentSection);
      }
      
      currentSection = {
        type: 'section',
        title: cleanLine,
        level: 2,
        content: []
      };
      continue;
    }
    
    // Check if it's a bullet point
    const isBullet = /^[-•]\s/.test(line);
    if (isBullet) {
      const bulletText = line.replace(/^[-•]\s/, '');
      if (currentSection) {
        currentSection.content.push({
          type: 'bullet',
          text: bulletText
        });
      }
      continue;
    }
    
    // Regular paragraph
    if (line && currentSection) {
      currentSection.content.push({
        type: 'paragraph',
        text: line
      });
    }
  }
  
  // Add last section
  if (currentSection) {
    sections.push(currentSection);
  }
  
  return sections;
}

/**
 * Create professional Word document
 */
function createProfessionalResume(sections, profileData) {
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22 } // 11pt default
        }
      },
      paragraphStyles: [
        {
          id: "SectionHeading",
          name: "Section Heading",
          basedOn: "Normal",
          next: "Normal",
          run: { size: 26, bold: true, font: "Calibri", color: "000000" },
          paragraph: {
            spacing: { before: SECTION_SPACING_BEFORE, after: SECTION_SPACING_AFTER },
            border: {
              bottom: {
                style: BorderStyle.SINGLE,
                size: 6,
                color: "000000"
              }
            }
          }
        }
      ]
    },
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: {
                  indent: { left: 720, hanging: 360 }
                }
              }
            }
          ]
        }
      ]
    },
    sections: [{
      properties: {
        page: {
          size: {
            width: 12240,   // 8.5 inches
            height: 15840   // 11 inches (US Letter)
          },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } // 1 inch margins
        }
      },
      children: buildDocumentContent(sections, profileData)
    }]
  });
  
  return doc;
}

/**
 * Build document content from parsed sections
 */
function buildDocumentContent(sections, profileData) {
  const content = [];
  
  // Add name (centered, large, bold)
  content.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: (profileData.name || '').toUpperCase(),
          bold: true,
          size: 32,
          font: "Calibri"
        })
      ]
    })
  );
  
  // Add contact info (centered)
  const contactParts = [];
  if (profileData.email) contactParts.push(profileData.email);
  if (profileData.phone) contactParts.push(profileData.phone);
  if (profileData.location) contactParts.push(profileData.location);
  
  if (contactParts.length > 0) {
    content.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [
          new TextRun({ text: contactParts.join('  •  '), size: 22 })
        ]
      })
    );
  }
  
  // Add LinkedIn if present
  if (profileData.linkedin) {
    content.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
        children: [
          new TextRun({
            text: profileData.linkedin,
            size: 22,
            color: "0563C1",
            underline: {}
          })
        ]
      })
    );
  }
  
  // Add sections
  sections.forEach(section => {
    // Section header. Uppercased here rather than relying on the generation
    // prompts, which are inconsistent: four of them mandate "## CAPS" while the
    // summary prompt does not specify case at all. Normalising at render time
    // guarantees every heading matches regardless of what the model returns.
    content.push(
      new Paragraph({
        text: (section.title || '').toUpperCase(),
        style: "SectionHeading"
      })
    );

    // Section content
    section.content.forEach((item, idx) => {
      if (item.type === 'bullet') {
        content.push(
          new Paragraph({
            numbering: { reference: "bullets", level: 0 },
            children: parseLineFormatting(item.text)
          })
        );
      } else if (item.type === 'paragraph') {
        // A role header is a whole-line bold paragraph (**Job Title**) — the
        // structure the experience prompts mandate. Give it space above so it
        // doesn't collide with the previous role's last bullet. Skipped for the
        // first item in a section, which already sits under a heading.
        const isRoleHeader = /^\*\*[^*]+\*\*$/.test(item.text.trim());
        content.push(
          new Paragraph({
            spacing: {
              before: (isRoleHeader && idx > 0) ? ROLE_SPACING_BEFORE : 0,
              after: 60
            },
            children: parseLineFormatting(item.text)
          })
        );
      }
    });
  });
  
  return content;
}

/**
 * Parse line formatting (bold with **text**)
 */
function parseLineFormatting(line) {
  const parts = [];
  const boldRegex = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match;
  
  while ((match = boldRegex.exec(line)) !== null) {
    // Add text before bold
    if (match.index > lastIndex) {
      const beforeText = line.substring(lastIndex, match.index);
      if (beforeText) {
        parts.push(new TextRun({ text: beforeText }));
      }
    }
    
    // Add bold text
    parts.push(new TextRun({ text: match[1], bold: true }));
    
    lastIndex = match.index + match[0].length;
  }
  
  // Add remaining text
  if (lastIndex < line.length) {
    const remainingText = line.substring(lastIndex);
    if (remainingText) {
      parts.push(new TextRun({ text: remainingText }));
    }
  }
  
  // If no formatting found, return plain text
  if (parts.length === 0) {
    parts.push(new TextRun({ text: line }));
  }
  
  return parts;
}
